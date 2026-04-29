import { TEAM_DB } from './constants.js';

export const ordinal = n => n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;

export const oddsToImpliedProb = odds => {
  if (odds == null) return null;
  if (odds < 0) return Math.abs(odds) / (Math.abs(odds) + 100) * 100;
  if (odds > 0) return 100 / (odds + 100) * 100;
  return null;
};

// ESPN CDN abbreviation overrides — some teams use shorter codes than API/Kalshi
const LOGO_CDN_ABBR = {
  nhl: { tbl: 'tb', njd: 'nj', lak: 'la', sjs: 'sj' },
  nba: { kat: 'atl' },
};
export const logoUrl = (sport, abbr) => {
  if (!abbr) return null;
  const lower = abbr.toLowerCase();
  const mapped = LOGO_CDN_ABBR[sport]?.[lower] ?? lower;
  return `https://a.espncdn.com/i/teamlogos/${sport}/500/${mapped}.png`;
};

export const fmtGameTime = gameTime => {
  if (!gameTime) return null;
  try {
    return new Date(gameTime).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit',
      timeZone: 'America/Los_Angeles', timeZoneName: 'short',
    });
  } catch { return null; }
};

export const getWeekMonday = (date = new Date()) => {
  const d = new Date(date);
  const dow = d.getDay();
  d.setDate(d.getDate() - (dow + 6) % 7);
  return d;
};

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
