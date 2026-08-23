/* db.js — IndexedDB storage layer.
 * Everything lives on the phone. No server, no account, no network required.
 */

const DB_NAME = 'shelfie';
const DB_VERSION = 1;

let _db = null;

export const STATUSES = ['reading', 'read', 'tbr', 'dnf'];

export const STATUS_LABEL = {
  reading: 'Reading',
  read: 'Read',
  tbr: 'TBR',
  dnf: 'DNF',
};

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) {
        const s = db.createObjectStore('books', { keyPath: 'id' });
        s.createIndex('by_status', 'status');
        s.createIndex('by_series', 'series');
        s.createIndex('by_added', 'dateAdded');
        s.createIndex('by_isbn', 'isbn13', { unique: false });
        s.createIndex('by_author', 'authorsLower', { multiEntry: true });
        s.createIndex('by_genre', 'genres', { multiEntry: true });
      }
      if (!db.objectStoreNames.contains('covers')) {
        db.createObjectStore('covers', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      void e;
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database is blocked by another open tab.'));
  });
}

export async function db() {
  if (!_db) _db = await open();
  return _db;
}

function tx(store, mode = 'readonly') {
  return db().then((d) => d.transaction(store, mode).objectStore(store));
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/* ---------- persistence ---------- */

/** Ask iOS/Safari not to evict our data when storage gets tight. */
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const already = await navigator.storage.persisted();
      if (already) return true;
      return await navigator.storage.persist();
    }
  } catch (_) { /* not supported */ }
  return false;
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      return await navigator.storage.estimate();
    }
  } catch (_) { /* ignore */ }
  return null;
}

/* ---------- normalisation ---------- */

const ARTICLES = /^(the|a|an)\s+/i;

export function sortTitleOf(title) {
  return String(title || '').trim().replace(ARTICLES, '').toLowerCase();
}

export function normaliseBook(raw) {
  const now = new Date().toISOString();
  const authors = (raw.authors || []).map((a) => String(a).trim()).filter(Boolean);
  const genres = dedupe((raw.genres || []).map((g) => String(g).trim()).filter(Boolean));
  const book = {
    id: raw.id || uid(),

    isbn13: raw.isbn13 || null,
    isbn10: raw.isbn10 || null,

    title: String(raw.title || 'Untitled').trim(),
    subtitle: raw.subtitle ? String(raw.subtitle).trim() : '',
    sortTitle: sortTitleOf(raw.title),

    authors,
    authorsLower: authors.map((a) => a.toLowerCase()),

    series: raw.series ? String(raw.series).trim() : '',
    seriesIndex: raw.seriesIndex == null || raw.seriesIndex === '' ? null : Number(raw.seriesIndex),

    genres,

    year: raw.year == null || raw.year === '' ? null : Number(raw.year),
    publisher: raw.publisher || '',
    pageCount: raw.pageCount == null || raw.pageCount === '' ? null : Number(raw.pageCount),
    language: raw.language || '',
    description: raw.description || '',

    coverUrl: raw.coverUrl || '',
    hasCover: !!raw.hasCover,
    // A coverUrl we've confirmed actually renders. Distinguishes a real remote
    // cover from a guessed URL that quietly 404s into a placeholder.
    coverVerified: !!raw.coverVerified,

    // true = it's on my shelf, false = read it but don't have it,
    // null = never said. Null matters: it keeps an import that carried no
    // ownership data from silently claiming you own nothing.
    owned: raw.owned === true ? true : (raw.owned === false ? false : null),

    status: STATUSES.includes(raw.status) ? raw.status : 'tbr',
    rating: raw.rating == null ? null : Number(raw.rating),
    review: raw.review || '',
    favorite: !!raw.favorite,
    tags: raw.tags || [],
    notes: raw.notes || '',

    sessions: (Array.isArray(raw.sessions) ? raw.sessions : []).map(normaliseSession),

    source: raw.source || 'manual',
    dateAdded: raw.dateAdded || now,
    dateModified: now,
  };
  if (Number.isNaN(book.year)) book.year = null;
  if (Number.isNaN(book.pageCount)) book.pageCount = null;
  if (Number.isNaN(book.seriesIndex)) book.seriesIndex = null;
  return book;
}

/**
 * A reading session. `finished` is deliberately separate from `finish`:
 * "I read this in 2009 but have no idea when" is a real and common case,
 * and a reread you can't date should still count as a reread.
 */
export function normaliseSession(s) {
  return {
    id: s.id || uid(),
    start: s.start || null,
    finish: s.finish || null,
    finished: s.finished != null ? !!s.finished : !!s.finish,
    // The date is inferred rather than recorded — shown with a ≈ so a guessed
    // date is never mistaken for one you actually logged.
    approx: !!s.approx,
    dnfAt: s.dnfAt || null,
    format: s.format || '',
    note: s.note || '',
  };
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) {
    const k = v.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(v); }
  }
  return out;
}

/* ---------- books CRUD ---------- */

export async function allBooks() {
  const store = await tx('books');
  return wrap(store.getAll());
}

export async function getBook(id) {
  const store = await tx('books');
  return wrap(store.get(id));
}

export async function putBook(raw) {
  const book = normaliseBook(raw);
  const store = await tx('books', 'readwrite');
  await wrap(store.put(book));
  return book;
}

/** Write many books in one transaction — used by the importer. */
export async function putBooks(rawList) {
  const d = await db();
  const books = rawList.map(normaliseBook);
  await new Promise((resolve, reject) => {
    const t = d.transaction('books', 'readwrite');
    const s = t.objectStore('books');
    books.forEach((b) => s.put(b));
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
  return books;
}

export async function deleteBook(id) {
  const d = await db();
  await new Promise((resolve, reject) => {
    const t = d.transaction(['books', 'covers'], 'readwrite');
    t.objectStore('books').delete(id);
    t.objectStore('covers').delete(id);
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

/** Is this ISBN already on the shelf? Prevents accidental double-scans. */
export async function findByIsbn(isbn) {
  if (!isbn) return null;
  const books = await allBooks();
  const clean = String(isbn).replace(/[^0-9Xx]/g, '');
  return books.find((b) => b.isbn13 === clean || b.isbn10 === clean) || null;
}

/* ---------- covers ---------- */

export async function putCover(bookId, blob) {
  const store = await tx('covers', 'readwrite');
  await wrap(store.put({ id: bookId, blob, type: blob.type || 'image/jpeg' }));
}

export async function getCover(bookId) {
  const store = await tx('covers');
  const rec = await wrap(store.get(bookId));
  return rec ? rec.blob : null;
}

export async function deleteCover(bookId) {
  const store = await tx('covers', 'readwrite');
  await wrap(store.delete(bookId));
}

/* ---------- meta ---------- */

export async function getMeta(key, fallback = null) {
  const store = await tx('meta');
  const rec = await wrap(store.get(key));
  return rec ? rec.value : fallback;
}

export async function setMeta(key, value) {
  const store = await tx('meta', 'readwrite');
  await wrap(store.put({ key, value }));
}

/* ---------- backup ---------- */

/** Full JSON backup. Covers are included as data URLs so a restore is complete. */
export async function exportBackup({ includeCovers = true } = {}) {
  const books = await allBooks();
  const payload = {
    format: 'shelfie-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    count: books.length,
    books,
    covers: {},
  };
  if (includeCovers) {
    for (const b of books) {
      if (!b.hasCover) continue;
      const blob = await getCover(b.id);
      if (blob) payload.covers[b.id] = await blobToDataUrl(blob);
    }
  }
  return payload;
}

export async function importBackup(payload, { merge = true } = {}) {
  if (!payload || payload.format !== 'shelfie-backup') {
    throw new Error('That file is not a Shelfie backup.');
  }
  if (!merge) {
    const d = await db();
    await new Promise((resolve, reject) => {
      const t = d.transaction(['books', 'covers'], 'readwrite');
      t.objectStore('books').clear();
      t.objectStore('covers').clear();
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  }
  await putBooks(payload.books || []);
  const covers = payload.covers || {};
  for (const [id, dataUrl] of Object.entries(covers)) {
    try {
      const blob = await dataUrlToBlob(dataUrl);
      await putCover(id, blob);
    } catch (_) { /* skip unreadable cover */ }
  }
  return (payload.books || []).length;
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}
