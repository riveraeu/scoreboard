// Shared Kalshi V2 order-placement/cancel client — the signing + payload chokepoint used by
// BOTH the user-facing /api/kalshi-order handler (manual/Place-All orders) and the automated
// shadow-maker V2 engine (api/lib/maker-live.js, real resting orders). Extracted 2026-07-21 so
// the two callers never drift on the V2 payload shape or RSA-PSS signing (see the 7/17 sunset
// of the legacy /portfolio/orders POST — api/lib/handlers/kalshi.js `_importKalshiKey`/PKCS1→8
// history is preserved here verbatim).
//
// CANCEL SCHEMA VERIFIED 2026-07-21 against a live call (via /api/maker-v2-verify-cancel):
// `DELETE /trade-api/v2/portfolio/events/orders/{order_id}` — the singular sibling of the
// documented batch-cancel endpoint (`DELETE .../events/orders/batched`), same `events/orders`
// V2 family our create-order call already uses (the legacy non-events `/portfolio/orders/*`
// family is what got sunset 7/17). Confirmed response shape: `{order_id, reduced_by, ts_ms}` —
// `reduced_by` is the fixed-point-string contract count removed from the resting order.

function _pkcs1ToPkcs8(pkcs1Der) {
  const _encLen = (len) => len < 128 ? [len] : len < 256 ? [0x81, len] : [0x82, (len >> 8) & 0xff, len & 0xff];
  const _seq = (c) => [0x30, ..._encLen(c.length), ...c];
  // AlgorithmIdentifier: SEQUENCE { OID rsaEncryption, NULL }
  const algId = _seq([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const version = [0x02, 0x01, 0x00];
  const octetStr = [0x04, ..._encLen(pkcs1Der.length), ...pkcs1Der];
  return new Uint8Array(_seq([...version, ...algId, ...octetStr]));
}

export async function importKalshiKey(pemString) {
  const pem = pemString.replace(/\\n/g, '\n').trim();
  const pemBody = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const der = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const pkcs8Der = pem.includes('BEGIN RSA PRIVATE KEY') ? _pkcs1ToPkcs8(der) : der;
  return crypto.subtle.importKey('pkcs8', pkcs8Der.buffer, { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['sign']);
}

async function _sign({ method, path, env }) {
  const timestamp = String(Date.now());
  const key = await importKalshiKey(env.KALSHI_PRIVATE_KEY);
  const msgBuf = new TextEncoder().encode(timestamp + method + path);
  const sigBuf = await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, key, msgBuf);
  return { timestamp, signature: btoa(String.fromCharCode(...new Uint8Array(sigBuf))) };
}

function _authHeaders(env, timestamp, signature) {
  return {
    "KALSHI-ACCESS-KEY": env.KALSHI_API_KEY_ID,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
    "KALSHI-ACCESS-SIGNATURE": signature,
  };
}

// Places a V2 event-order. `side` is our yes/no contract (not Kalshi's bid/ask book-side
// terms — that translation happens here). `expirationTime` (optional, Unix SECONDS) pairs with
// time_in_force:"good_till_canceled" to make a self-expiring resting order — Kalshi auto-cancels
// it at that time with no further call, which is how maker-live.js avoids needing an explicit
// cancel for the common "no longer eligible" case (only reprice/kill-switch need real cancels).
// Returns { ok:true, orderId, clientOrderId, fillCount, remainingCount, avgFillPriceCents, raw }
// or { ok:false, error, status }.
export async function placeKalshiOrder({ ticker, side, price, count, clientOrderId, expirationTime }, env) {
  if (!env?.KALSHI_API_KEY_ID || !env?.KALSHI_PRIVATE_KEY) return { ok: false, error: "Kalshi API not configured" };
  const kalshiPath = "/trade-api/v2/portfolio/events/orders";
  const orderPayload = {
    ticker,
    client_order_id: clientOrderId || crypto.randomUUID(),
    side: side === "yes" ? "bid" : "ask",
    count: String(count),
    price: (side === "yes" ? price / 100 : (100 - price) / 100).toFixed(4),
    time_in_force: "good_till_canceled",
    self_trade_prevention_type: "taker_at_cross",
    ...(expirationTime ? { expiration_time: expirationTime } : {}),
  };
  let timestamp, signature;
  try {
    ({ timestamp, signature } = await _sign({ method: "POST", path: kalshiPath, env }));
  } catch (e) {
    return { ok: false, error: `Signing failed: ${e?.message || e}` };
  }
  const resp = await fetch(`https://external-api.kalshi.com${kalshiPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ..._authHeaders(env, timestamp, signature) },
    body: JSON.stringify(orderPayload),
  }).catch(() => null);
  if (!resp) return { ok: false, error: "Kalshi unreachable" };
  const respBody = await resp.json().catch(() => ({}));
  if (!resp.ok) return { ok: false, error: respBody?.error?.message || `Kalshi error ${resp.status}`, status: resp.status };
  const filled = Math.round(parseFloat(respBody.fill_count ?? "0")) || 0;
  const remaining = Math.round(parseFloat(respBody.remaining_count ?? "0")) || 0;
  const avgYesCents = respBody.average_fill_price != null ? Math.round(parseFloat(respBody.average_fill_price) * 100) : null;
  const avgFillPriceCents = avgYesCents == null ? null : (side === "yes" ? avgYesCents : 100 - avgYesCents);
  return {
    ok: true,
    orderId: respBody.order_id,
    clientOrderId: respBody.client_order_id ?? orderPayload.client_order_id,
    fillCount: filled,
    remainingCount: remaining,
    avgFillPriceCents,
    raw: respBody,
  };
}

// Reads the account's currently-UNSETTLED real positions (ticker set only). Used by
// gradeResolvedMakerPositions (maker-live.js) to distinguish "we independently know the true
// outcome via ESPN" from "Kalshi has actually settled/credited this market" — those are NOT the
// same moment (2026-07-22 finding: same-day grading exposed real positions still open on
// Kalshi's own books hours after ESPN called the game final). A ticker not confirmed settled
// stays counted as an open position (status='executed', graded_at still NULL) even once its
// true outcome is known, rather than moving into realized PnL ahead of the real cash movement.
export async function fetchUnsettledTickers(env) {
  if (!env?.KALSHI_API_KEY_ID || !env?.KALSHI_PRIVATE_KEY) return { ok: false, error: "Kalshi API not configured" };
  const kalshiPath = "/trade-api/v2/portfolio/positions";
  let timestamp, signature;
  try {
    ({ timestamp, signature } = await _sign({ method: "GET", path: kalshiPath, env }));
  } catch (e) {
    return { ok: false, error: `Signing failed: ${e?.message || e}` };
  }
  const resp = await fetch(`https://api.elections.kalshi.com${kalshiPath}?settlement_status=unsettled&limit=1000`, {
    headers: _authHeaders(env, timestamp, signature),
  }).catch(() => null);
  if (!resp) return { ok: false, error: "Kalshi unreachable" };
  const respBody = await resp.json().catch(() => ({}));
  if (!resp.ok) return { ok: false, error: respBody?.error?.message || `Kalshi error ${resp.status}`, status: resp.status };
  const tickers = new Set((respBody.market_positions || []).map(p => p.ticker).filter(Boolean));
  return { ok: true, tickers };
}

// Reads the account's real fills (legacy read path — NOT part of the 7/17 V2 sunset, same
// endpoint /api/kalshi-fills already uses). Used by maker-live.js's nightly reconcile pass to
// detect which resting V2 orders got filled, matched by kalshi_order_id.
export async function fetchKalshiFills({ minTs, limit = 1000 } = {}, env) {
  if (!env?.KALSHI_API_KEY_ID || !env?.KALSHI_PRIVATE_KEY) return { ok: false, error: "Kalshi API not configured" };
  const kalshiPath = "/trade-api/v2/portfolio/fills";
  const qs = `?limit=${limit}${minTs ? `&min_ts=${encodeURIComponent(minTs)}` : ""}`;
  let timestamp, signature;
  try {
    ({ timestamp, signature } = await _sign({ method: "GET", path: kalshiPath, env }));
  } catch (e) {
    return { ok: false, error: `Signing failed: ${e?.message || e}` };
  }
  const resp = await fetch(`https://api.elections.kalshi.com${kalshiPath}${qs}`, {
    headers: _authHeaders(env, timestamp, signature),
  }).catch(() => null);
  if (!resp) return { ok: false, error: "Kalshi unreachable" };
  const respBody = await resp.json().catch(() => ({}));
  if (!resp.ok) return { ok: false, error: respBody?.error?.message || `Kalshi error ${resp.status}`, status: resp.status };
  return { ok: true, fills: respBody.fills ?? [] };
}

// Reads the account's actual settlements — Kalshi's own authoritative record of what a settled
// market credited. `revenue` is GROSS payout (0 or 100¢/contract), NOT net of our cost or fees —
// callers must subtract both themselves (see gradeResolvedMakerPositions). Replaces the earlier
// ESPN-derived pnl_cents math + fetchUnsettledTickers gate: a from-scratch cross-check against
// this feed (2026-07-22) found the OLD ESPN-derived side_won formula disagreed with Kalshi's own
// settlement on several spread/team-total markets — sign errors worth real dollars, not just
// rounding — so this is now the sole source of truth, not a supplement. A market only APPEARS
// here once Kalshi has actually settled it, so this single call is both the accuracy and the
// timing signal in one — no separate "is it settled yet" check needed. Single page (limit≤1000,
// no cursor) — V2's daily volume is nowhere near that in any few-day lookback.
export async function fetchKalshiSettlements({ minTs, limit = 1000 } = {}, env) {
  if (!env?.KALSHI_API_KEY_ID || !env?.KALSHI_PRIVATE_KEY) return { ok: false, error: "Kalshi API not configured" };
  const kalshiPath = "/trade-api/v2/portfolio/settlements";
  const qs = `?limit=${limit}${minTs ? `&min_ts=${encodeURIComponent(minTs)}` : ""}`;
  let timestamp, signature;
  try {
    ({ timestamp, signature } = await _sign({ method: "GET", path: kalshiPath, env }));
  } catch (e) {
    return { ok: false, error: `Signing failed: ${e?.message || e}` };
  }
  const resp = await fetch(`https://api.elections.kalshi.com${kalshiPath}${qs}`, {
    headers: _authHeaders(env, timestamp, signature),
  }).catch(() => null);
  if (!resp) return { ok: false, error: "Kalshi unreachable" };
  const respBody = await resp.json().catch(() => ({}));
  if (!resp.ok) return { ok: false, error: respBody?.error?.message || `Kalshi error ${resp.status}`, status: resp.status };
  const settlements = (respBody.settlements || []).map(s => ({
    ticker: s.ticker,
    marketResult: s.market_result,
    revenueCents: Math.round(Number(s.revenue) || 0),
    feeCents: Math.round((parseFloat(s.fee_cost_dollars ?? s.fee_cost) || 0) * 100),
    settledTime: s.settled_time,
  }));
  return { ok: true, settlements };
}

// Cancels a single resting order. See the CANCEL SCHEMA note at the top of this file — verify
// against a live test call before this is ever invoked with armed=true.
export async function cancelKalshiOrder({ orderId }, env) {
  if (!env?.KALSHI_API_KEY_ID || !env?.KALSHI_PRIVATE_KEY) return { ok: false, error: "Kalshi API not configured" };
  const kalshiPath = `/trade-api/v2/portfolio/events/orders/${orderId}`;
  let timestamp, signature;
  try {
    ({ timestamp, signature } = await _sign({ method: "DELETE", path: kalshiPath, env }));
  } catch (e) {
    return { ok: false, error: `Signing failed: ${e?.message || e}` };
  }
  const resp = await fetch(`https://external-api.kalshi.com${kalshiPath}`, {
    method: "DELETE",
    headers: _authHeaders(env, timestamp, signature),
  }).catch(() => null);
  if (!resp) return { ok: false, error: "Kalshi unreachable" };
  const respBody = await resp.json().catch(() => ({}));
  if (!resp.ok) return { ok: false, error: respBody?.error?.message || `Kalshi error ${resp.status}`, status: resp.status };
  // reduced_by = contracts actually removed from the resting order. If it's less than what the
  // caller expected still resting, the difference filled in the gap between their last check
  // and this cancel call — callers should reconcile that, not assume "canceled" == "no fill".
  const reducedBy = Math.round(parseFloat(respBody.reduced_by ?? "0")) || 0;
  return { ok: true, reducedBy, raw: respBody };
}
