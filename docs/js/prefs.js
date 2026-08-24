/* prefs.js — small view preferences, remembered between launches. */

const KEY = 'shelfie:prefs';

const DEFAULTS = {
  view: 'shelf',      // 'shelf' | 'grid'
  groupBy: 'series',  // series | author | genre | shelf
  status: 'all',
  owned: 'any',       // any | owned | unowned — ANDs with status
  sort: 'author',     // key into store.SORTS
  theme: 'auto',      // auto | light | dark
};

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (_) {
    return { ...DEFAULTS };
  }
}

export const prefs = read();

export function setPref(key, value) {
  prefs[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch (_) { /* private browsing — preferences just won't stick */ }
}
