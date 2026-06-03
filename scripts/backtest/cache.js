// Disk cache for MLB Stats API responses. Keyed by URL md5 hash.
// First run fetches + writes; subsequent runs skip the network entirely.
import { createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dir, ".cache");

if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

function cacheKey(url) {
  return join(CACHE_DIR, createHash("md5").update(url).digest("hex") + ".json");
}

export async function fetchCached(url, { concurrencyToken = null } = {}) {
  const path = cacheKey(url);
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8"));
  }
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const data = await res.json();
  writeFileSync(path, JSON.stringify(data));
  return data;
}

// Fetch a list of URLs with bounded concurrency (avoid hammering the API).
export async function fetchAll(urls, concurrency = 20, label = "") {
  const results = new Array(urls.length);
  let idx = 0;
  let done = 0;
  const total = urls.length;

  async function worker() {
    while (idx < urls.length) {
      const i = idx++;
      results[i] = await fetchCached(urls[i]);
      done++;
      if (label && done % 100 === 0) process.stdout.write(`\r  ${label}: ${done}/${total}`);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  if (label) console.log(`\r  ${label}: ${total}/${total} done`);
  return results;
}
