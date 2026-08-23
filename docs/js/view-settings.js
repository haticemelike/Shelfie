/* view-settings.js — import, backup, and housekeeping. */

import { h, clear, toast, sheet, confirmSheet, downloadFile, plural, fmtDate } from './ui.js';
import * as store from './store.js';
import * as db from './db.js';
import { parseGoodreads, looksLikeGoodreads } from './goodreads.js';
import { lookupIsbn, fetchCoverBlob } from './lookup.js';
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
            ? `${plural(missing.length, 'book')} still need artwork or genres. This looks each one up and downloads its cover — it needs a connection and takes a moment per book.`
            : 'Every book has artwork. Nothing to fetch.'),
        h('div', { class: 'progress', id: 'enrich-progress', hidden: true },
          h('div', { class: 'progress__bar', id: 'enrich-bar' })),
        h('p', { class: 'muted tiny', id: 'enrich-status' }, ''),
        missing.length
          ? h('button', {
            class: 'btn btn--ghost btn--block', type: 'button', id: 'enrich-btn',
            onclick: (e) => enrich(missing, e.currentTarget),
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

  const { books, total, skipped } = parseGoodreads(text);
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

function booksMissingArtwork() {
  return store.all().filter((b) => (!b.hasCover && !b.coverUrl) || !(b.genres || []).length);
}

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

  let done = 0;
  let updated = 0;

  for (const b of list) {
    if (enrichAbort) break;
    const current = store.get(b.id);
    if (!current) { done++; continue; }
    status.textContent = `${current.title}…`;

    try {
      const isbn = current.isbn13 || current.isbn10;
      let found = null;
      if (isbn) found = await lookupIsbn(isbn);

      if (found) {
        const patch = { ...current };
        if (!patch.genres?.length && found.genres?.length) patch.genres = found.genres;
        for (const k of ['series', 'seriesIndex', 'year', 'pageCount', 'publisher', 'description', 'subtitle']) {
          if ((patch[k] == null || patch[k] === '') && found[k]) patch[k] = found[k];
        }
        if (!patch.coverUrl && found.coverUrl) patch.coverUrl = found.coverUrl;
        await store.save(patch);

        if (!patch.hasCover && patch.coverUrl) {
          const blob = await fetchCoverBlob(patch.coverUrl);
          if (blob) await store.setCover(patch.id, blob);
        }
        updated++;
      }
    } catch (_) { /* one bad lookup shouldn't stop the run */ }

    done++;
    bar.style.width = `${Math.round((done / list.length) * 100)}%`;
    // Be a polite guest on free public APIs.
    await sleep(320);
  }

  status.textContent = enrichAbort
    ? `Stopped. Updated ${plural(updated, 'book')}.`
    : `Done. Updated ${plural(updated, 'book')}.`;
  btn.dataset.running = '';
  btn.textContent = 'Fetch again for what is still missing';
  enrichAbort = false;
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
