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

/* ---------- row -> book ---------- */

export function rowToBook(row) {
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
    sessions.push({
      id: uid(), start: null, finish: dateRead || null, finished: true, dnfAt: null,
      format: String(row['Binding'] || '').trim(), note: '',
    });
  } else if (status === 'dnf') {
    sessions.push({ id: uid(), start: null, finish: null, finished: false, dnfAt: dateRead || null, format: '', note: '' });
  } else if (status === 'reading') {
    sessions.push({ id: uid(), start: dateAdded || null, finish: null, finished: false, dnfAt: null, format: '', note: '' });
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
  const books = [];
  const skipped = [];
  for (const row of rows) {
    const b = rowToBook(row);
    if (b) books.push(b); else skipped.push(row);
  }
  return { books, skipped: skipped.length, total: rows.length };
}

/** Detect whether a CSV really is a Goodreads export before we trust the columns. */
export function looksLikeGoodreads(text) {
  const firstLine = String(text || '').split('\n')[0] || '';
  return /Exclusive Shelf/i.test(firstLine) || (/Title/i.test(firstLine) && /Author/i.test(firstLine));
}
