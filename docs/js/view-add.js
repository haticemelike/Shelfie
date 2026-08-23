/* view-add.js — three ways in: barcode, ISBN by hand, or title/author search. */

import { h, clear, toast, sheet, spinner, emptyState, debounce, authorLine, downloadFile } from './ui.js';
import { exportBackup } from './db.js';
import { BarcodeScanner, barcodeToIsbn } from './scanner.js';
import { lookupIsbn, searchBooks, findCover, cleanIsbn, isValidIsbn, toIsbn13 } from './lookup.js';
import * as store from './store.js';
import { findByIsbn } from './db.js';
import { STATUSES, STATUS_LABEL } from './db.js';
import { coverNode } from './covers.js';
import { openBook } from './view-book.js';
import { shrinkImage, splitList } from './view-book.js';

let scanner = null;
let addedThisSession = [];
let busyIsbn = null;

export function renderAdd(container) {
  clear(container);
  addedThisSession = [];

  const video = h('video', {
    class: 'scan__video',
    playsinline: true,
    muted: true,
    autoplay: true,
    'webkit-playsinline': 'true',
  });

  const hint = h('p', { class: 'scan__hint muted' },
    'Point the camera at the barcode on the back cover.');

  const startBtn = h('button', {
    class: 'btn btn--primary btn--block',
    type: 'button',
    onclick: () => startScanning(video, hint, startBtn, stopBtn),
  }, '📷 Start camera');

  const stopBtn = h('button', {
    class: 'btn btn--ghost btn--block',
    type: 'button',
    hidden: true,
    onclick: () => stopScanning(video, hint, startBtn, stopBtn),
  }, 'Stop camera');

  const manualInput = h('input', {
    class: 'input',
    type: 'text',
    inputmode: 'numeric',
    placeholder: '978…',
    enterkeyhint: 'go',
    autocomplete: 'off',
    onkeydown: (e) => { if (e.key === 'Enter') submitManual(manualInput); },
  });

  const searchInput = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'Title, or title + author',
    enterkeyhint: 'search',
    autocomplete: 'off',
    oninput: debounce((e) => runSearch(e.target.value, searchResults), 450),
  });

  const searchResults = h('div', { class: 'addsearch__results' });

  container.append(
    h('div', { class: 'add' },
      h('section', { class: 'card scan' },
        h('div', { class: 'scan__frame' },
          video,
          h('div', { class: 'scan__reticle', 'aria-hidden': 'true' })
        ),
        hint,
        startBtn,
        stopBtn
      ),

      h('section', { class: 'card' },
        h('h3', { class: 'card__title' }, 'Type the ISBN'),
        h('p', { class: 'muted tiny' },
          'The 13-digit number under the barcode. Tip: tap and hold the box, then choose Scan Text to read it with the camera.'),
        h('div', { class: 'inline-form' },
          manualInput,
          h('button', { class: 'btn btn--primary', type: 'button', onclick: () => submitManual(manualInput) }, 'Find')
        )
      ),

      h('section', { class: 'card' },
        h('h3', { class: 'card__title' }, 'No barcode? Search by name'),
        searchInput,
        searchResults
      ),

      h('section', { class: 'card card--quiet' },
        h('h3', { class: 'card__title' }, 'Add it yourself'),
        h('p', { class: 'muted tiny' }, 'For anything the internet has never heard of.'),
        h('button', { class: 'btn btn--ghost btn--block', type: 'button', onclick: () => reviewSheet({}, { manual: true }) }, 'Blank book entry')
      ),

      h('div', { class: 'add__log', id: 'add-log' })
    )
  );
}

export function leaveAdd() {
  if (scanner) {
    scanner.stop();
    scanner = null;
  }
}

/* ---------- camera ---------- */

async function startScanning(video, hint, startBtn, stopBtn) {
  if (!isSecure()) {
    hint.textContent = 'The camera only works over a secure (https) connection.';
    return;
  }
  hint.textContent = 'Starting camera…';
  scanner = new BarcodeScanner(video);
  await scanner.start(
    (code) => onBarcode(code, hint),
    (err) => {
      hint.textContent = err.message;
      hint.classList.add('scan__hint--error');
      startBtn.hidden = false;
      stopBtn.hidden = true;
      scanner = null;
      offerSafariEscape(hint);
    }
  );
  if (scanner && scanner.running) {
    hint.classList.remove('scan__hint--error');
    hint.textContent = 'Hunting for a barcode…';
    startBtn.hidden = true;
    stopBtn.hidden = false;
    video.classList.add('is-live');
  }
}

function stopScanning(video, hint, startBtn, stopBtn) {
  if (scanner) scanner.stop();
  scanner = null;
  video.classList.remove('is-live');
  hint.textContent = 'Point the camera at the barcode on the back cover.';
  startBtn.hidden = false;
  stopBtn.hidden = true;
}

function isSecure() {
  return window.isSecureContext || location.protocol === 'https:' || location.hostname === 'localhost';
}

/**
 * iOS refuses camera access more often when a web app is running from the
 * Home Screen than it does in Safari itself, so offer a way out.
 *
 * The catch, and the reason this isn't a plain link: iOS gives a Home Screen
 * web app its own storage, separate from Safari's. Opening the same URL in
 * Safari shows an EMPTY library, and anything scanned there stays there.
 * So we explain that before sending anyone across, and offer the backup file
 * as the bridge.
 */
function offerSafariEscape(hint) {
  const standalone = window.navigator.standalone === true
    || window.matchMedia('(display-mode: standalone)').matches;
  if (!standalone) return;
  if (hint.parentElement.querySelector('.scan__escape')) return;

  hint.after(h('button', {
    class: 'btn btn--ghost btn--block scan__escape',
    type: 'button',
    onclick: safariWarningSheet,
  }, 'Try Safari instead…'));
}

function safariWarningSheet() {
  const body = h('div', {},
    h('p', {}, 'Safari can usually open the camera when the Home Screen app can’t.'),
    h('p', { class: 'muted' },
      'But iOS keeps them completely separate: Safari has its own copy of Shelfie with its own, empty library. Books you scan there will not appear here.'),
    h('p', { class: 'muted' },
      'If you want to move over for good, save a backup first, open Safari, and restore it there.')
  );
  sheet('Safari keeps a separate library', body, {
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save a backup',
        onClick: async () => {
          const payload = await exportBackup();
          downloadFile(`shelfie-backup-${new Date().toISOString().slice(0, 10)}.json`,
            JSON.stringify(payload));
          toast('Backup saved — restore it in Safari from Settings.');
        },
      },
      {
        label: 'Open Safari',
        variant: 'primary',
        onClick: () => window.open(location.href, '_blank'),
      },
    ],
  });
}

async function onBarcode(code, hint) {
  const isbn = barcodeToIsbn(code);
  if (!isbn) {
    hint.textContent = 'That looked like a price sticker, not an ISBN. Try the barcode above it.';
    return;
  }
  if (busyIsbn === isbn) return;
  busyIsbn = isbn;

  const existing = await findByIsbn(isbn);
  if (existing) {
    hint.textContent = `Already on your shelves: ${existing.title}`;
    toast(`“${existing.title}” is already in your library.`);
    setTimeout(() => { busyIsbn = null; }, 1500);
    return;
  }

  hint.textContent = 'Found ' + isbn + ' — looking it up…';
  const found = await lookupIsbn(isbn);
  busyIsbn = null;

  if (!found) {
    hint.textContent = 'No record for that ISBN. Add the details yourself?';
    reviewSheet({ isbn13: toIsbn13(isbn) || isbn }, { manual: true, fromScan: true });
    return;
  }
  hint.textContent = 'Hunting for a barcode…';
  reviewSheet(found, { keepScanning: true, fromScan: true });
}

/* ---------- manual ISBN ---------- */

async function submitManual(input) {
  const raw = cleanIsbn(input.value);
  if (!raw) return;
  if (!isValidIsbn(raw)) {
    toast('That is not a valid ISBN — check for a typo.', { error: true });
    return;
  }
  const existing = await findByIsbn(raw);
  if (existing) {
    toast(`Already on your shelves: “${existing.title}”`);
    input.value = '';
    return;
  }
  toast('Looking it up…');
  const found = await lookupIsbn(raw);
  input.value = '';
  if (!found) {
    toast('No record found — fill it in yourself.', { error: true });
    reviewSheet({ isbn13: toIsbn13(raw) || raw }, { manual: true, fromScan: true });
    return;
  }
  // Typing an ISBN off the back cover also means the book is in your hands.
  reviewSheet(found, { fromScan: true });
}

/* ---------- title/author search ---------- */

async function runSearch(query, box) {
  clear(box);
  if (!query || query.trim().length < 3) return;
  box.append(spinner('Searching…'));
  let results = [];
  try {
    results = await searchBooks(query, { limit: 12 });
  } catch (_) { /* offline */ }
  clear(box);
  if (!results.length) {
    box.append(h('p', { class: 'muted' }, 'Nothing found. Check the spelling, or add it yourself below.'));
    return;
  }
  for (const r of results) {
    box.append(h('button', {
      class: 'result',
      type: 'button',
      onclick: () => reviewSheet(r),
    },
      r.coverUrl
        ? h('img', { class: 'result__cover', src: r.coverUrl, alt: '', loading: 'lazy' })
        : h('div', { class: 'result__cover result__cover--none' }, '📕'),
      h('div', { class: 'result__meta' },
        h('span', { class: 'result__title' }, r.title),
        h('span', { class: 'result__author muted' }, (r.authors || []).join(', ') || 'Unknown author'),
        h('span', { class: 'result__facts muted tiny' },
          [r.year, r.pageCount ? `${r.pageCount}p` : null].filter(Boolean).join(' · '))
      )
    ));
  }
}

/* ---------- confirm & save ---------- */

function reviewSheet(found, { keepScanning = false, manual = false, fromScan = false } = {}) {
  let status = 'tbr';

  const f = {
    title: h('input', { class: 'input', value: found.title || '' }),
    authors: h('input', { class: 'input', value: (found.authors || []).join(', '), placeholder: 'Comma separated' }),
    series: h('input', { class: 'input', value: found.series || '' }),
    seriesIndex: h('input', { class: 'input', type: 'number', step: '0.5', value: found.seriesIndex ?? '' }),
    genres: h('input', { class: 'input', value: (found.genres || []).join(', ') }),
    year: h('input', { class: 'input', type: 'number', value: found.year ?? '' }),
    pageCount: h('input', { class: 'input', type: 'number', value: found.pageCount ?? '' }),
    isbn13: h('input', { class: 'input', value: found.isbn13 || '', inputmode: 'numeric' }),
  };

  const statusRow = h('div', { class: 'seg seg--wide' },
    ...STATUSES.map((s) => h('button', {
      class: 'seg__btn' + (s === status ? ' is-on' : ''),
      type: 'button',
      onclick: (e) => {
        status = s;
        [...e.currentTarget.parentElement.children].forEach((c) => c.classList.remove('is-on'));
        e.currentTarget.classList.add('is-on');
      },
    }, STATUS_LABEL[s]))
  );

  const preview = found.coverUrl
    ? h('img', { class: 'review__cover', src: found.coverUrl, alt: '' })
    : h('div', { class: 'review__cover review__cover--none' }, '📕');

  // Scanning a barcode means the book is in your hands; searching for one by
  // name usually doesn't, so the default follows how you got here.
  const ownedBox = h('input', { class: 'checkbox', type: 'checkbox' });
  ownedBox.checked = fromScan;

  const body = h('div', { class: 'review' },
    h('div', { class: 'review__top' },
      preview,
      h('div', { class: 'review__fields' },
        field('Title', f.title),
        field('Authors', f.authors)
      )
    ),
    h('div', { class: 'form' },
      h('label', { class: 'check' }, ownedBox,
        h('span', {}, 'I have a copy of this')),
      h('span', { class: 'field__label' }, 'Shelf'),
      statusRow,
      field('Series', f.series),
      field('Number in series', f.seriesIndex),
      field('Genres', f.genres),
      field('Year', f.year),
      field('Pages', f.pageCount),
      field('ISBN', f.isbn13)
    )
  );

  sheet(manual ? 'Add a book' : 'Add this book?', body, {
    actions: [
      { label: 'Skip' },
      {
        label: 'Add to library',
        variant: 'primary',
        onClick: async () => {
          const title = f.title.value.trim();
          if (!title) { toast('A title, at least.', { error: true }); return true; }

          const book = await store.save({
            isbn13: f.isbn13.value.trim() || null,
            isbn10: found.isbn10 || null,
            title,
            subtitle: found.subtitle || '',
            authors: splitList(f.authors.value),
            series: f.series.value.trim(),
            seriesIndex: f.seriesIndex.value === '' ? null : Number(f.seriesIndex.value),
            genres: splitList(f.genres.value),
            year: f.year.value === '' ? null : Number(f.year.value),
            pageCount: f.pageCount.value === '' ? null : Number(f.pageCount.value),
            publisher: found.publisher || '',
            language: found.language || '',
            description: found.description || '',
            coverUrl: found.coverUrl || '',
            status,
            owned: ownedBox.checked,
            sessions: newSessionsFor(status),
            source: found.source || 'manual',
          });

          logAdded(book);
          toast(`Added “${book.title}”`);

          // Cover hunting happens after saving so the book appears instantly.
          findCover(book, found).then(async (cover) => {
            if (!cover) return;
            if (cover.blob) await store.setCover(book.id, cover.blob);
            const fresh = store.get(book.id);
            if (fresh) await store.save({ ...fresh, coverUrl: cover.url, coverVerified: true });
          });
          void keepScanning;
        },
      },
    ],
  });
}

function field(label, input) {
  return h('label', { class: 'field' }, h('span', { class: 'field__label' }, label), input);
}

/** Adding straight to "Read" or "Reading" should log a date, not just a label. */
function newSessionsFor(status) {
  const day = new Date().toISOString().slice(0, 10);
  const base = { id: crypto.randomUUID ? crypto.randomUUID() : 's' + Date.now().toString(36), start: null, finish: null, finished: false, dnfAt: null, format: '', note: '' };
  if (status === 'read') return [{ ...base, finish: day, finished: true }];
  if (status === 'reading') return [{ ...base, start: day }];
  if (status === 'dnf') return [{ ...base, dnfAt: day }];
  return [];
}

function logAdded(book) {
  addedThisSession.unshift(book);
  const log = document.getElementById('add-log');
  if (!log) return;
  clear(log);
  if (!addedThisSession.length) return;
  log.append(
    h('h3', { class: 'card__title' }, `Added just now (${addedThisSession.length})`),
    h('div', { class: 'grid grid--sm' }, addedThisSession.slice(0, 12).map((b) =>
      h('button', { class: 'gbook', type: 'button', onclick: () => openBook(b.id) },
        h('div', { class: 'gbook__art' }, coverNode(b)),
        h('div', { class: 'gbook__meta' },
          h('span', { class: 'gbook__title' }, b.title),
          h('span', { class: 'gbook__author muted' }, authorLine(b))
        ))))
  );
}

/* Unused import guard — keeps bundlers/linters honest about the shared helper. */
void shrinkImage;
void emptyState;
