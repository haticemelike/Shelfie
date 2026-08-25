/* goodreads.js — import a Goodreads library export.
 *
 * Goodreads' CSV quirks it has to survive:
 *   - ISBN cells look like ="0439023483" (an Excel formula guard)
 *   - Dates are "2019/04/23"
 *   - Reviews contain raw HTML with <br/>
 *   - "Read Count" can exceed 1 but only the latest Date Read is kept
 *   - Series lives inside the title: "Words of Radiance (The Stormlight Archive, #2)"
 */

import { normaliseGenres, parseTitleSeries, toIsbn13 } from './lookup.js';
import { uid } from './db.js';

/* ---------- CSV ---------- */

export function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  const src = text.replace(/^﻿/, ''); // strip BOM

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(cell); cell = '';
    } else if (c === '\n') {
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else if (c === '\r') {
      // handled by \n
    } else {
      cell += c;
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }

  if (!rows.length) return [];
  const header = rows[0].map((hh) => hh.trim());
  return rows.slice(1)
    .filter((r) => r.some((v) => String(v).trim() !== ''))
    .map((r) => {
      const obj = {};
      header.forEach((key, i) => { obj[key] = r[i] == null ? '' : r[i]; });
      return obj;
    });
}

/* ---------- field cleaning ---------- */

function unExcel(v) {
  return String(v || '').replace(/^="?/, '').replace(/"?$/, '').trim();
}

function toISODate(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function stripHtml(v) {
  return String(v || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}

function num(v) {
  const n = Number(String(v || '').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/* Shelf names people actually use, mapped to a status. */
const DNF_SHELF = /\b(dnf|did-?not-?finish|abandoned|gave-?up|unfinished)\b/i;
const READING_SHELF = /currently-reading|reading/i;

/* Ownership signals. Goodreads has an "Owned Copies" column, but plenty of
 * people never use it and shelve things by hand instead. */
const OWNED_SHELF = /\b(owned|i-?own|own-?it|physical|hardcopy|my-?(books|library|shelf|shelves)|on-?my-?shelf|bookshelf|signed)\b/i;
const NOT_OWNED_SHELF = /\b(library|borrowed|loaned|lent|kindle-?unlimited|scribd|everand|wishlist|want-?to-?buy)\b/i;

function shelvesOf(row) {
  return String(row['Bookshelves'] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

function statusOf(row) {
  const shelves = shelvesOf(row);
  if (shelves.some((s) => DNF_SHELF.test(s))) return 'dnf';
  const exclusive = String(row['Exclusive Shelf'] || '').trim().toLowerCase();
  if (exclusive === 'read') return 'read';
  if (exclusive === 'currently-reading') return 'reading';
  if (exclusive === 'to-read') return 'tbr';
  if (shelves.some((s) => READING_SHELF.test(s))) return 'reading';
  return 'tbr';
}

/**
 * Does this export say anything about ownership at all?
 *
 * If nobody ever ticked "I own a copy" in Goodreads, every row reads
 * `Owned Copies = 0`, and treating that as "owns nothing" would grey out an
 * entire library. So we only trust the column when the file proves it was used.
 */
export function hasOwnershipSignal(rows) {
  return rows.some((row) => {
    if (Number(row['Owned Copies'] || 0) > 0) return true;
    const shelves = shelvesOf(row);
    return shelves.some((s) => OWNED_SHELF.test(s) || NOT_OWNED_SHELF.test(s));
  });
}

function ownedOf(row, ownershipKnown) {
  if (Number(row['Owned Copies'] || 0) > 0) return true;
  const shelves = shelvesOf(row);
  if (shelves.some((s) => OWNED_SHELF.test(s))) return true;
  if (shelves.some((s) => NOT_OWNED_SHELF.test(s))) return false;
  return ownershipKnown ? false : null;
}

/* ---------- row -> book ---------- */

export function rowToBook(row, { ownershipKnown = true } = {}) {
  const rawTitle = String(row['Title'] || '').trim();
  if (!rawTitle) return null;

  const st = parseTitleSeries(rawTitle);
  const title = st && st.cleanTitle ? st.cleanTitle : rawTitle;

  const isbn10 = unExcel(row['ISBN']) || null;
  const isbn13raw = unExcel(row['ISBN13']) || null;
  const isbn13 = isbn13raw || (isbn10 ? toIsbn13(isbn10) : null);

  const authors = [String(row['Author'] || '').trim()]
    .concat(String(row['Additional Authors'] || '').split(',').map((s) => s.trim()))
    .filter(Boolean);

  const status = statusOf(row);
  const dateRead = toISODate(row['Date Read']);
  const dateAdded = toISODate(row['Date Added']);
  const readCount = Math.max(0, Number(row['Read Count'] || 0) || 0);

  /* When Goodreads has no Date Read, "Date Added" is the best evidence there is:
   * most people add a book at the point they finish it, or when they shelve one
   * they've just read. It's an inference, not a record, so anything derived this
   * way is flagged `approx` and displayed with a ≈. */
  const ADDED_NOTE = 'Date taken from when you added it to Goodreads';

  const sessions = [];
  if (status === 'read') {
    // Goodreads keeps only the latest finish date, so earlier rereads are
    // recorded as undated entries — the count survives even if the dates don't.
    const extra = Math.max(0, readCount - 1);
    for (let i = 0; i < extra; i++) {
      sessions.push({
        id: uid(), start: null, finish: null, finished: true, dnfAt: null, format: '',
        note: 'Earlier read (undated)',
      });
    }
    const guessedFinish = !dateRead && !!dateAdded;
    sessions.push({
      id: uid(), start: null,
      finish: dateRead || dateAdded || null,
      finished: true, approx: guessedFinish, dnfAt: null,
      format: String(row['Binding'] || '').trim(),
      note: guessedFinish ? ADDED_NOTE : '',
    });
  } else if (status === 'dnf') {
    // Same reasoning: you shelved it as abandoned around the time you gave up.
    const guessedDnf = !dateRead && !!dateAdded;
    sessions.push({
      id: uid(), start: null, finish: null, finished: false,
      dnfAt: dateRead || dateAdded || null,
      approx: guessedDnf, format: '',
      note: guessedDnf ? ADDED_NOTE : '',
    });
  } else if (status === 'reading') {
    // Date Added is the only start-date evidence a Goodreads export carries.
    sessions.push({
      id: uid(), start: dateAdded || null, finish: null, finished: false, dnfAt: null,
      approx: !!dateAdded, format: '',
      note: dateAdded ? ADDED_NOTE : '',
    });
  }

  const shelves = shelvesOf(row);
  // Shelf names go through as-is; the genre rules already handle "epic-fantasy".
  const genres = normaliseGenres(shelves);

  const myRating = Number(row['My Rating'] || 0);

  return {
    isbn13,
    isbn10: isbn10 && isbn10.length === 10 ? isbn10 : null,
    title,
    subtitle: '',
    authors,
    series: st ? st.series : '',
    seriesIndex: st ? st.seriesIndex : null,
    genres,
    year: num(row['Original Publication Year']) || num(row['Year Published']),
    publisher: String(row['Publisher'] || '').trim(),
    pageCount: num(row['Number of Pages']),
    status,
    owned: ownedOf(row, ownershipKnown),
    copies: Math.max(1, Number(row['Owned Copies'] || 0) || 1),
    rating: myRating > 0 ? myRating : null,
    review: stripHtml(row['My Review']),
    notes: stripHtml(row['Private Notes']),
    tags: shelves.filter((s) => !/^(read|to-read|currently-reading)$/i.test(s)),
    sessions,
    coverUrl: '',
    dateAdded: dateAdded ? new Date(dateAdded).toISOString() : new Date().toISOString(),
    source: 'goodreads',
  };
}

export function parseGoodreads(text) {
  const rows = parseCSV(text);
  const ownershipKnown = hasOwnershipSignal(rows);
  const books = [];
  const skipped = [];
  let inferredDates = 0;
  for (const row of rows) {
    const b = rowToBook(row, { ownershipKnown });
    if (!b) { skipped.push(row); continue; }
    if (b.sessions.some((sess) => sess.approx)) inferredDates++;
    books.push(b);
  }
  return { books, skipped: skipped.length, total: rows.length, ownershipKnown, inferredDates };
}

/* ---------- re-importing over books you already have ---------- */

const FILLABLE = [
  'series', 'seriesIndex', 'year', 'pageCount', 'publisher',
  'isbn13', 'isbn10', 'genres', 'tags', 'review', 'notes', 'rating',
];

/* `copies` is deliberately not in FILLABLE: 1 is a real value, not a gap, so
 * a re-import must never quietly overwrite a count you set by hand. */

function isEmpty(v) {
  return v == null || v === '' || (Array.isArray(v) && v.length === 0);
}

function anyDate(sessions) {
  return (sessions || []).some((s) => s.start || s.finish || s.dnfAt);
}

/**
 * Merge a CSV row's data into a book that's already on the shelves.
 *
 * Strictly gap-filling. Anything you have already — a rating you changed, a
 * review you rewrote, dates you entered by hand, a status you moved — wins.
 * This is what lets a later import backfill fields that earlier versions of
 * the app never worked out, without undoing your own edits.
 */
export function mergeGoodreadsInto(existing, incoming) {
  const book = { ...existing };
  const changed = [];

  for (const key of FILLABLE) {
    if (isEmpty(book[key]) && !isEmpty(incoming[key])) {
      book[key] = incoming[key];
      changed.push(key);
    }
  }

  if (book.owned == null && incoming.owned != null) {
    book.owned = incoming.owned;
    changed.push('owned');
  }

  // Only ever raise it — and only from an export that actually tracked copies.
  if ((incoming.copies || 1) > (book.copies || 1)) {
    book.copies = incoming.copies;
    changed.push('copies');
  }

  // Dates are only adopted when the book currently has none at all, so an
  // import can never overwrite reading history you entered yourself.
  if (!anyDate(book.sessions) && anyDate(incoming.sessions)) {
    book.sessions = incoming.sessions;
    changed.push('dates');
  }

  // Status is left alone on purpose — it's the field you're most likely to
  // have curated in the app after importing.
  return { book, changed };
}

/** Key a book for matching between a CSV and the library. */
export function matchKey(book) {
  if (book.isbn13) return 'isbn:' + book.isbn13;
  return 'ta:' + String(book.title || '').toLowerCase().trim()
    + '|' + String((book.authors || [])[0] || '').toLowerCase().trim();
}

/** Detect whether a CSV really is a Goodreads export before we trust the columns. */
export function looksLikeGoodreads(text) {
  const firstLine = String(text || '').split('\n')[0] || '';
  return /Exclusive Shelf/i.test(firstLine) || (/Title/i.test(firstLine) && /Author/i.test(firstLine));
}
