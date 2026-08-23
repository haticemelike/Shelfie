/* view-settings.js — import, backup, and housekeeping. */

import { h, clear, toast, sheet, confirmSheet, downloadFile, plural, fmtDate } from './ui.js';
import * as store from './store.js';
import * as db from './db.js';
import { parseGoodreads, looksLikeGoodreads } from './goodreads.js';
import {
  lookupIsbn, fetchCoverBlob, coverUrlForIsbn, searchBooks, plausibleMatch,
} from './lookup.js';
import { prefs, setPref } from './prefs.js';
import { applyTheme } from './theme.js';

let enrichAbort = false;

export function renderSettings(container) {
  clear(container);

  const grImport = h('input', { type: 'file', accept: '.csv,text/csv', class: 'file-input', id: 'gr-file' });
  const backupImport = h('input', { type: 'file', accept: '.json,application/json', class: 'file-input', id: 'bk-file' });

  grImport.addEventListener('change', () => handleGoodreads(grImport));
  backupImport.addEventListener('change', () => handleRestore(backupImport));

  const missing = booksMissingArtwork();

  container.append(
    h('div', { class: 'settings' },

      h('section', { class: 'card' },
        h('h3', { class: 'card__title' }, 'Your library'),
        h('p', { class: 'muted' },
          `${plural(store.count(), 'book')} · ${plural(store.stats().seriesCount, 'series', 'series')} · ${plural(store.stats().authorCount, 'author')}`),
        h('p', { class: 'muted tiny', id: 'storage-line' }, 'Checking storage…')
      ),

      h('section', { class: 'card' },
        h('h3', { class: 'card__title' }, 'Import from Goodreads'),
        h('p', { class: 'muted tiny' },
          'On a computer, open Goodreads → My Books → Import and Export → Export Library. Save the CSV, AirDrop or email it to your phone, then pick it here.'),
        h('label', { class: 'btn btn--primary btn--block', for: 'gr-file' }, 'Choose Goodreads CSV'),
        grImport
      ),

      h('section', { class: 'card' },
        h('h3', { class: 'card__title' }, 'Fetch covers & genres'),
        h('p', { class: 'muted tiny' },
          missing.length
            ? `${plural(missing.length, 'book')} still need artwork or genres — roughly ${etaFor(missing.length)}. `
              + 'Keep the screen on and this tab in front, or iOS pauses it. You can stop and resume any time; it picks up where it left off.'
            : 'Every book has artwork. Nothing to fetch.'),
        h('div', { class: 'progress', id: 'enrich-progress', hidden: true },
          h('div', { class: 'progress__bar', id: 'enrich-bar' })),
        h('p', { class: 'muted tiny', id: 'enrich-status' }, ''),
        missing.length
          ? h('button', {
            class: 'btn btn--ghost btn--block', type: 'button', id: 'enrich-btn',
            // Recompute on each press so a second run only covers what's left.
            onclick: (e) => enrich(booksMissingArtwork(), e.currentTarget),
          }, `Fetch for ${missing.length} book${missing.length === 1 ? '' : 's'}`)
          : null
      ),

      h('section', { class: 'card' },
        h('h3', { class: 'card__title' }, 'Backup'),
        h('p', { class: 'muted tiny' },
          'Your library lives only on this phone. Save a backup somewhere safe now and then — the file includes every cover, rating, review and date.'),
        h('button', {
          class: 'btn btn--primary btn--block', type: 'button',
          onclick: () => doBackup(),
        }, '⤓ Save a backup file'),
        h('label', { class: 'btn btn--ghost btn--block', for: 'bk-file' }, '⤒ Restore from a backup'),
        backupImport,
        h('p', { class: 'muted tiny', id: 'last-backup' }, '')
      ),

      h('section', { class: 'card' },
        h('h3', { class: 'card__title' }, 'Appearance'),
        h('div', { class: 'seg seg--wide' },
          ...['auto', 'light', 'dark'].map((t) => h('button', {
            class: 'seg__btn' + (prefs.theme === t ? ' is-on' : ''),
            type: 'button',
            onclick: (e) => {
              setPref('theme', t);
              applyTheme();
              [...e.currentTarget.parentElement.children].forEach((c) => c.classList.remove('is-on'));
              e.currentTarget.classList.add('is-on');
            },
          }, t[0].toUpperCase() + t.slice(1)))
        )
      ),

      h('section', { class: 'card card--quiet' },
        h('h3', { class: 'card__title' }, 'Danger zone'),
        h('button', {
          class: 'btn btn--danger btn--block', type: 'button',
          onclick: async () => {
            if (await confirmSheet('Erase everything?',
              `All ${store.count()} books, ratings, reviews and dates will be deleted from this phone. Save a backup first if you might want them back.`,
              { confirmLabel: 'Erase everything' })) {
              for (const b of [...store.all()]) await store.remove(b.id);
              toast('Library erased');
              renderSettings(container);
            }
          },
        }, 'Erase my library')
      ),

      h('section', { class: 'card card--quiet' },
        h('h3', { class: 'card__title' }, 'About'),
        h('p', { class: 'muted tiny' },
          'Shelfie keeps everything on your phone — no account, no server, nothing uploaded. Book details come from Open Library and Google Books, both free.'),
        h('p', { class: 'muted tiny' }, 'Works offline once loaded. Add it to your Home Screen for the full-screen version.')
      )
    )
  );

  showStorage();
  showLastBackup();
}

/* ---------- storage ---------- */

async function showStorage() {
  const line = document.getElementById('storage-line');
  if (!line) return;
  const est = await db.storageEstimate();
  const persisted = await db.requestPersistence();
  const parts = [];
  if (est && est.usage != null) parts.push(`${(est.usage / 1024 / 1024).toFixed(1)} MB used`);
  parts.push(persisted ? 'storage marked permanent' : 'storage not marked permanent — keep backups');
  line.textContent = parts.join(' · ');
}

async function showLastBackup() {
  const line = document.getElementById('last-backup');
  if (!line) return;
  const at = await db.getMeta('lastBackupAt');
  line.textContent = at ? `Last backup: ${fmtDate(at)}` : 'No backup saved yet.';
}

/* ---------- goodreads ---------- */

async function handleGoodreads(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;

  const text = await file.text();
  if (!looksLikeGoodreads(text)) {
    toast('That does not look like a Goodreads export.', { error: true });
    return;
  }

  const { books, total, skipped, ownershipKnown } = parseGoodreads(text);
  if (!books.length) {
    toast('No books found in that file.', { error: true });
    return;
  }

  const existingIsbns = new Set(store.all().map((b) => b.isbn13).filter(Boolean));
  const existingTitles = new Set(store.all().map((b) => (b.title + '|' + (b.authors[0] || '')).toLowerCase()));
  const fresh = books.filter((b) => {
    if (b.isbn13 && existingIsbns.has(b.isbn13)) return false;
    if (existingTitles.has((b.title + '|' + (b.authors[0] || '')).toLowerCase())) return false;
    return true;
  });
  const dupes = books.length - fresh.length;

  const counts = fresh.reduce((acc, b) => { acc[b.status] = (acc[b.status] || 0) + 1; return acc; }, {});

  const body = h('div', {},
    h('p', {}, `Found ${plural(books.length, 'book')} in ${plural(total, 'row')}.`),
    h('ul', { class: 'bullets' },
      Object.entries(counts).map(([k, v]) => h('li', {}, `${v} → ${db.STATUS_LABEL[k] || k}`))),
    dupes ? h('p', { class: 'muted' }, `${plural(dupes, 'book')} already on your shelves will be skipped.`) : null,
    skipped ? h('p', { class: 'muted' }, `${plural(skipped, 'row')} had no title and were ignored.`) : null,
    h('p', { class: 'muted' }, ownershipKnown
      ? `${fresh.filter((b) => b.owned).length} of these are marked as owned in your export — the rest will show faded on the shelves.`
      : 'Your export has no ownership information (Goodreads’ “Owned Copies” was never used), so nothing is marked owned or not. Set it per book, or leave it.'),
    h('p', { class: 'muted tiny' }, 'Covers are not in the export — fetch them afterwards from Settings.')
  );

  sheet('Import from Goodreads', body, {
    actions: [
      { label: 'Cancel' },
      {
        label: `Import ${fresh.length}`,
        variant: 'primary',
        onClick: async () => {
          if (!fresh.length) { toast('Nothing new to import.'); return; }
          await store.saveMany(fresh);
          toast(`Imported ${plural(fresh.length, 'book')}`);
          renderSettings(document.getElementById('view'));
        },
      },
    ],
  });
}

/* ---------- enrichment ---------- */

/** Four at a time, call it half a second each once latency is accounted for. */
function etaFor(n) {
  const seconds = Math.round((n * 0.5));
  if (seconds < 60) return 'under a minute';
  const mins = Math.round(seconds / 60);
  return mins < 60 ? `${mins} minute${mins === 1 ? '' : 's'}` : `${Math.round(mins / 60)} hours`;
}

function booksMissingArtwork() {
  return store.all().filter((b) => (!b.hasCover && !b.coverUrl) || !(b.genres || []).length);
}

/**
 * Bulk-fill covers and genres.
 *
 * The naive version of this was slow and looked broken. Four reasons, all fixed:
 *   1. It ran one book at a time. Now four run at once.
 *   2. It always fetched full metadata, even when only the cover was missing.
 *      Open Library serves covers straight off an ISBN, so that case is now a
 *      single image request with no JSON at all.
 *   3. Books with no ISBN were skipped in silence — the bar advanced, nothing
 *      happened. Those now fall back to a title+author search, with a sanity
 *      check so a near-miss never attaches the wrong cover.
 *   4. Failures were invisible. The counters below make it obvious when the
 *      lookup services have stopped answering, and the run gives up and says so
 *      rather than grinding through hundreds of books for nothing.
 */
async function enrich(list, btn) {
  if (btn.dataset.running === '1') {
    enrichAbort = true;
    btn.textContent = 'Stopping…';
    return;
  }
  enrichAbort = false;
  btn.dataset.running = '1';
  btn.textContent = 'Stop';

  const bar = document.getElementById('enrich-bar');
  const wrap = document.getElementById('enrich-progress');
  const status = document.getElementById('enrich-status');
  wrap.hidden = false;

  // iOS suspends a backgrounded page, which stalls the whole run. Ask to keep
  // the screen awake; harmless if the browser says no.
  const wake = await keepAwake();

  const counts = { done: 0, updated: 0, notFound: 0 };
  let missStreak = 0;
  let gaveUp = false;

  const paint = () => {
    bar.style.width = `${Math.round((counts.done / list.length) * 100)}%`;
    status.textContent =
      `${counts.done} of ${list.length} · ${counts.updated} updated`
      + (counts.notFound ? ` · ${counts.notFound} not found` : '');
  };
  paint();

  await runPool(list, async (book) => {
    if (enrichAbort || gaveUp) return;
    let outcome = 'notfound';
    try {
      outcome = await enrichOne(book);
    } catch (_) {
      outcome = 'notfound';
    }

    counts.done++;
    if (outcome === 'updated') { counts.updated++; missStreak = 0; }
    else if (outcome === 'notfound') { counts.notFound++; missStreak++; }

    // Nothing at all coming back usually means we're being rate-limited.
    // Grinding on wastes minutes and looks like a hang.
    if (missStreak >= 25 && counts.updated === 0) {
      gaveUp = true;
      enrichAbort = true;
    }
    paint();
  }, { concurrency: 4 });

  if (gaveUp) {
    status.textContent = 'Nothing is coming back from Open Library or Google Books — '
      + 'they may be busy or rate-limiting. Wait a few minutes and try again; '
      + 'it picks up where it left off.';
  } else if (enrichAbort) {
    status.textContent = `Stopped. ${counts.updated} updated, ${counts.done} of ${list.length} checked.`;
  } else {
    status.textContent = `Done. ${counts.updated} updated`
      + (counts.notFound ? `, ${counts.notFound} had no match online.` : '.');
  }

  releaseAwake(wake);
  btn.dataset.running = '';
  btn.textContent = 'Fetch again for what is still missing';
  enrichAbort = false;
  // Deliberately no re-render here — it would wipe the summary just written.
  // The button recomputes what's still missing when tapped again.
}

/** Returns 'updated' | 'notfound' | 'skip'. */
async function enrichOne(book) {
  const current = store.get(book.id);
  if (!current) return 'skip';

  const needCover = !current.hasCover;
  const needMeta = !(current.genres || []).length;
  const isbn = current.isbn13 || current.isbn10;

  // Cheapest possible path: cover only, straight off the ISBN.
  if (needCover && !needMeta && isbn) {
    const blob = await fetchCoverBlob(coverUrlForIsbn(isbn));
    if (blob) { await store.setCover(current.id, blob); return 'updated'; }
    return 'notfound';
  }

  let found = isbn ? await lookupIsbn(isbn) : null;

  // No ISBN, or neither service knows it — try the title and author instead.
  if (!found) {
    const query = [current.title, (current.authors || [])[0]].filter(Boolean).join(' ');
    const hits = query ? await searchBooks(query, { limit: 3 }) : [];
    found = hits.find((hit) => plausibleMatch(current, hit)) || null;
  }
  if (!found) return 'notfound';

  const patch = { ...current };
  let changed = false;

  if (!patch.genres?.length && found.genres?.length) { patch.genres = found.genres; changed = true; }
  if (!patch.authors?.length && found.authors?.length) { patch.authors = found.authors; changed = true; }
  for (const k of ['series', 'seriesIndex', 'year', 'pageCount', 'publisher', 'description', 'subtitle']) {
    if ((patch[k] == null || patch[k] === '') && found[k]) { patch[k] = found[k]; changed = true; }
  }
  if (!patch.coverUrl && found.coverUrl) { patch.coverUrl = found.coverUrl; changed = true; }
  if (changed) await store.save(patch);

  if (!patch.hasCover) {
    const url = patch.coverUrl || (isbn ? coverUrlForIsbn(isbn) : '');
    const blob = await fetchCoverBlob(url);
    if (blob) { await store.setCover(patch.id, blob); changed = true; }
  }

  return changed ? 'updated' : 'notfound';
}

/** Run `worker` over `items` with a fixed number in flight at once. */
async function runPool(items, worker, { concurrency = 4 } = {}) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length && !enrichAbort) {
      const item = items[next++];
      await worker(item);
      await sleep(120);  // stay a polite guest on free public APIs
    }
  });
  await Promise.all(lanes);
}

async function keepAwake() {
  try {
    if (navigator.wakeLock && navigator.wakeLock.request) {
      return await navigator.wakeLock.request('screen');
    }
  } catch (_) { /* not supported, or denied — the run just needs the screen on */ }
  return null;
}

function releaseAwake(lock) {
  try { if (lock && lock.release) lock.release(); } catch (_) { /* already gone */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- backup ---------- */

async function doBackup() {
  toast('Building backup…');
  const payload = await db.exportBackup();
  const stamp = new Date().toISOString().slice(0, 10);
  downloadFile(`shelfie-backup-${stamp}.json`, JSON.stringify(payload));
  await db.setMeta('lastBackupAt', new Date().toISOString());
  showLastBackup();
  toast(`Backed up ${plural(payload.count, 'book')}`);
}

async function handleRestore(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;

  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch (_) {
    toast('That file could not be read.', { error: true });
    return;
  }
  if (payload.format !== 'shelfie-backup') {
    toast('That is not a Shelfie backup file.', { error: true });
    return;
  }

  const body = h('div', {},
    h('p', {}, `This backup holds ${plural(payload.count || (payload.books || []).length, 'book')}, saved ${fmtDate(payload.exportedAt)}.`),
    h('p', { class: 'muted' }, 'Merging keeps what is already here and adds anything missing. Replacing wipes this phone’s library first.')
  );

  sheet('Restore backup', body, {
    actions: [
      { label: 'Cancel' },
      {
        label: 'Merge',
        onClick: async () => {
          const n = await db.importBackup(payload, { merge: true });
          await store.load();
          toast(`Restored ${plural(n, 'book')}`);
          renderSettings(document.getElementById('view'));
        },
      },
      {
        label: 'Replace',
        variant: 'danger',
        onClick: async () => {
          if (!await confirmSheet('Replace everything?', 'The current library on this phone will be erased first.', { confirmLabel: 'Replace' })) return true;
          const n = await db.importBackup(payload, { merge: false });
          await store.load();
          toast(`Restored ${plural(n, 'book')}`);
          renderSettings(document.getElementById('view'));
        },
      },
    ],
  });
}
