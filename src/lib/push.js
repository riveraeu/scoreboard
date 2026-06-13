// Web Push client helpers (PWA background notifications).
//
// The existing foreground path (useTonight → new Notification(...)) only fires while the
// tab/PWA is open and polling. This module subscribes the browser's PushManager to the
// backend so the server can deliver notifications when the app is CLOSED — the actual
// mobile use case. On iOS 16.4+ this only works once the site is installed to the Home
// Screen (standalone); a Safari tab silently no-ops, so callers should gate on isStandalone().
import { WORKER } from './constants.js';

// True when running as an installed PWA (iOS `navigator.standalone`, others via display-mode).
export function isStandalone() {
  if (typeof window === 'undefined') return false;
  return (
    window.navigator.standalone === true ||
    window.matchMedia?.('(display-mode: standalone)')?.matches === true
  );
}

// iOS Safari (incl. installed PWA) — used to show the "Add to Home Screen" hint.
export function isIOS() {
  if (typeof navigator === 'undefined') return false;
  return (
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) // iPadOS reports as Mac
  );
}

export function pushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

// VAPID public key is base64url; PushManager wants a Uint8Array.
function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

// Current subscription state: 'unsupported' | 'denied' | 'subscribed' | 'unsubscribed'.
export async function getPushState() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub ? 'subscribed' : 'unsubscribed';
  } catch {
    return 'unsubscribed';
  }
}

// Subscribe this browser and register the subscription with the backend.
// Throws on failure; caller surfaces the message. Sends the JWT cookie via credentials.
export async function subscribeToPush() {
  if (!pushSupported()) throw new Error('Push not supported on this browser');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications permission was not granted');

  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await fetch(`${WORKER}/push/vapid`).then(r => r.json());
  if (!publicKey) throw new Error('Server VAPID key unavailable');

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  const r = await fetch(`${WORKER}/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sub),
    credentials: 'include',
  });
  if (!r.ok) throw new Error(`Failed to register subscription (${r.status})`);
  return sub;
}

// Unsubscribe locally and tell the backend to drop the row.
export async function unsubscribeFromPush() {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await fetch(`${WORKER}/push/unsubscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint }),
    credentials: 'include',
  }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}
