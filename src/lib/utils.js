import { TEAM_DB } from './constants.js';

export function lsGet(key, ttlMs) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > ttlMs) return null;
    return data;
  } catch { return null; }
}

export function lsSet(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data })); } catch {}
}

export const ordinal = n => n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;

export const slugify = name =>
  name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "");

const _multiSportAbbrs = (() => {
  const seen = {};
  TEAM_DB.forEach(t => { seen[t.abbr] = (seen[t.abbr] || 0) + 1; });
  return new Set(Object.keys(seen).filter(a => seen[a] > 1));
})();

export function teamUrl(abbr, sport) {
  const upper = abbr.toUpperCase();
  const defaultSport = TEAM_DB.find(t => t.abbr === upper)?.sport;
  return `/${upper}${_multiSportAbbrs.has(upper) && sport !== defaultSport ? `?sport=${sport}` : ""}`;
}
