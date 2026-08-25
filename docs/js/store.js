/* store.js — the whole library kept in memory, mirrored to IndexedDB.
 * A personal library is a few thousand books at most, so searching and
 * grouping in memory is instant and far simpler than clever index queries.
 */

import * as db from './db.js';
import { revokeCover } from './covers.js';

const listeners = new Set();
let books = [];
let loaded = false;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of listeners) fn(books);
}

export async function load() {
  books = await db.allBooks();
  loaded = true;
  emit();
  return books;
}

export function isLoaded() { return loaded; }
export function all() { return books; }
export function get(id) { return books.find((b) => b.id === id) || null; }
export function count() { return books.length; }

export async function save(raw) {
  const book = await db.putBook(raw);
  const i = books.findIndex((b) => b.id === book.id);
  if (i >= 0) books[i] = book; else books.push(book);
  emit();
  return book;
}

export async function saveMany(list) {
  const saved = await db.putBooks(list);
  for (const book of saved) {
    const i = books.findIndex((b) => b.id === book.id);
    if (i >= 0) books[i] = book; else books.push(book);
  }
  emit();
  return saved;
}

export async function remove(id) {
  await db.deleteBook(id);
  revokeCover(id);
  books = books.filter((b) => b.id !== id);
  emit();
}

export async function setCover(bookId, blob) {
  await db.putCover(bookId, await downscaleCover(blob));
  revokeCover(bookId);
  const b = get(bookId);
  if (b) await save({ ...b, hasCover: true });
}

/**
 * Covers are stored no taller than 420px — twice the biggest size the app ever
 * draws one, so still crisp on a retina screen, at roughly a quarter of the
 * bytes and decode cost of a full-size publisher image.
 */
const MAX_COVER_HEIGHT = 420;

async function downscaleCover(blob) {
  try {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return blob;
    const bitmap = await createImageBitmap(blob);
    if (bitmap.height <= MAX_COVER_HEIGHT) { bitmap.close?.(); return blob; }
    const scale = MAX_COVER_HEIGHT / bitmap.height;
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), MAX_COVER_HEIGHT);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const small = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    return small && small.size < blob.size ? small : blob;
  } catch (_) {
    return blob;   // any trouble: keep the original rather than lose the cover
  }
}

/* ---------- reading sessions (this is what makes rereads work) ---------- */

/**
 * Sessions are append-only. Finishing a book you've read before adds a new
 * entry rather than overwriting the old one, so the history stays intact.
 */
export async function addSession(bookId, session) {
  const book = get(bookId);
  if (!book) return null;
  const sessions = [...(book.sessions || []), db.normaliseSession(session)];
  return save({ ...book, sessions });
}

export async function updateSession(bookId, sessionId, patch) {
  const book = get(bookId);
  if (!book) return null;
  const sessions = (book.sessions || []).map((s) => (s.id === sessionId ? { ...s, ...patch } : s));
  return save({ ...book, sessions });
}

export async function removeSession(bookId, sessionId) {
  const book = get(bookId);
  if (!book) return null;
  const sessions = (book.sessions || []).filter((s) => s.id !== sessionId);
  return save({ ...book, sessions });
}

export function finishedCount(book) {
  return (book.sessions || []).filter((s) => s.finished || s.finish).length;
}

export function isReread(book) {
  return finishedCount(book) > 1;
}

export function lastFinished(book) {
  const dates = (book.sessions || []).map((s) => s.finish).filter(Boolean).sort();
  return dates.length ? dates[dates.length - 1] : null;
}

/* ---------- bulk edits ---------- */

/**
 * Apply the same change to many books at once, in one transaction.
 * `patchFor` receives each book so status changes can log their own dates.
 */
export async function updateMany(ids, patchFor) {
  const updated = [];
  for (const id of ids) {
    const book = get(id);
    if (!book) continue;
    const patch = typeof patchFor === 'function' ? patchFor(book) : patchFor;
    if (patch) updated.push({ ...book, ...patch });
  }
  if (!updated.length) return [];
  return saveMany(updated);
}

export async function removeMany(ids) {
  for (const id of ids) await remove(id);
}

/* ---------- search & filter ---------- */

function fold(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Match on title, subtitle, author, series, genre, ISBN. */
export function search(query, list = books) {
  const q = fold(query).trim();
  if (!q) return list;
  const terms = q.split(/\s+/);
  return list
    .map((b) => ({ b, score: scoreBook(b, terms, q) }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score)
    .map((x) => x.b);
}

function scoreBook(b, terms, whole) {
  const title = fold(b.title);
  const subtitle = fold(b.subtitle);
  const authors = fold((b.authors || []).join(' '));
  const series = fold(b.series);
  const genres = fold((b.genres || []).join(' '));
  const isbn = `${b.isbn13 || ''} ${b.isbn10 || ''}`;

  let score = 0;
  if (title === whole) score += 100;
  if (title.startsWith(whole)) score += 40;
  if (authors.includes(whole)) score += 30;
  if (series.includes(whole)) score += 20;

  for (const t of terms) {
    let hit = 0;
    if (title.includes(t)) hit += 10;
    if (authors.includes(t)) hit += 8;
    if (series.includes(t)) hit += 5;
    if (subtitle.includes(t)) hit += 3;
    if (genres.includes(t)) hit += 2;
    if (isbn.includes(t)) hit += 12;
    if (hit === 0) return 0; // every term must match something
    score += hit;
  }
  return score;
}

export function filterByStatus(status, list = books) {
  if (!status || status === 'all') return list;
  if (status === 'favorites') return list.filter((b) => b.favorite);
  return list.filter((b) => b.status === status);
}

/** Ownership is a separate axis from status, so it ANDs with it. */
export function filterByOwned(mode, list = books) {
  if (mode === 'owned') return list.filter((b) => b.owned === true);
  if (mode === 'unowned') return list.filter((b) => b.owned === false);
  return list;
}

/* ---------- grouping ---------- */

export const GROUPINGS = ['series', 'author', 'genre', 'shelf'];

export const GROUPING_LABEL = {
  series: 'Series',
  author: 'Author',
  genre: 'Genre',
  shelf: 'All',
};

/** Returns [{ key, label, books }] ready to render as shelves. */
export function group(by, list = books) {
  if (by === 'shelf' || !by) {
    return [{ key: 'all', label: 'All books', books: sortByAuthorTitle(list) }];
  }

  const map = new Map();
  const orphans = [];

  for (const b of list) {
    let keys = [];
    if (by === 'series') keys = b.series ? [b.series] : [];
    else if (by === 'author') keys = (b.authors || []).length ? [b.authors[0]] : [];
    else if (by === 'genre') keys = (b.genres || []).length ? b.genres : [];

    if (!keys.length) { orphans.push(b); continue; }
    for (const k of keys) {
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(b);
    }
  }

  const groups = [...map.entries()].map(([key, items]) => ({
    key,
    label: key,
    books: by === 'series' ? sortBySeriesIndex(items) : sortByAuthorTitle(items),
  }));

  groups.sort((a, b) => {
    if (by === 'series' || by === 'genre') {
      if (b.books.length !== a.books.length) return b.books.length - a.books.length;
    }
    return collate(a.label, b.label);
  });

  if (by === 'author') groups.sort((a, b) => collate(lastName(a.label), lastName(b.label)));

  if (orphans.length) {
    groups.push({
      key: '__none__',
      label: by === 'series' ? 'Standalone' : by === 'genre' ? 'Uncategorised' : 'Unknown author',
      books: sortByAuthorTitle(orphans),
    });
  }
  return groups;
}

function collate(a, b) {
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
}

export function lastName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : (parts[0] || '');
}

function sortBySeriesIndex(list) {
  return [...list].sort((a, b) => {
    const ai = a.seriesIndex == null ? Infinity : a.seriesIndex;
    const bi = b.seriesIndex == null ? Infinity : b.seriesIndex;
    if (ai !== bi) return ai - bi;
    return collate(a.sortTitle, b.sortTitle);
  });
}

function sortByAuthorTitle(list) {
  return [...list].sort((a, b) => {
    const an = lastName((a.authors || [])[0] || 'zzz');
    const bn = lastName((b.authors || [])[0] || 'zzz');
    const c = collate(an, bn);
    if (c !== 0) return c;
    if (a.series && a.series === b.series) {
      const ai = a.seriesIndex == null ? Infinity : a.seriesIndex;
      const bi = b.seriesIndex == null ? Infinity : b.seriesIndex;
      if (ai !== bi) return ai - bi;
    }
    return collate(a.sortTitle, b.sortTitle);
  });
}

export const SORTS = {
  author: { label: 'Author', fn: sortByAuthorTitle },
  title: { label: 'Title', fn: (l) => [...l].sort((a, b) => collate(a.sortTitle, b.sortTitle)) },
  added: { label: 'Recently added', fn: (l) => [...l].sort((a, b) => String(b.dateAdded).localeCompare(String(a.dateAdded))) },
  rating: { label: 'Rating', fn: (l) => [...l].sort((a, b) => (b.rating || 0) - (a.rating || 0)) },
  year: { label: 'Year', fn: (l) => [...l].sort((a, b) => (b.year || 0) - (a.year || 0)) },
  finished: {
    label: 'Recently finished',
    fn: (l) => [...l].sort((a, b) => String(lastFinished(b) || '').localeCompare(String(lastFinished(a) || ''))),
  },
};

/* ---------- suggestions for the edit form ---------- */

export function knownValues(field) {
  const set = new Set();
  for (const b of books) {
    const v = b[field];
    if (Array.isArray(v)) v.forEach((x) => x && set.add(x));
    else if (v) set.add(v);
  }
  return [...set].sort(collate);
}

/* ---------- stats ---------- */

export function stats() {
  const byStatus = { reading: 0, read: 0, tbr: 0, dnf: 0 };
  let pages = 0;
  let rated = 0;
  let ratingSum = 0;
  let rereads = 0;
  let owned = 0;
  let unowned = 0;
  let ownUnset = 0;
  const finishesByYear = new Map();

  for (const b of books) {
    if (byStatus[b.status] != null) byStatus[b.status]++;
    if (b.owned === true) owned++;
    else if (b.owned === false) unowned++;
    else ownUnset++;
    if (b.rating) { rated++; ratingSum += b.rating; }
    if (isReread(b)) rereads++;
    for (const s of b.sessions || []) {
      if (!s.finish) continue;
      if (b.pageCount) pages += b.pageCount;
      const y = new Date(s.finish).getFullYear();
      if (!Number.isNaN(y)) finishesByYear.set(y, (finishesByYear.get(y) || 0) + 1);
    }
  }

  return {
    total: books.length,
    byStatus,
    pagesRead: pages,
    avgRating: rated ? ratingSum / rated : null,
    ratedCount: rated,
    rereads,
    owned,
    unowned,
    ownUnset,
    byYear: [...finishesByYear.entries()].sort((a, b) => b[0] - a[0]),
    seriesCount: new Set(books.filter((b) => b.series).map((b) => b.series)).size,
    authorCount: new Set(books.flatMap((b) => b.authors || [])).size,
  };
}
