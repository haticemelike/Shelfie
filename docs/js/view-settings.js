/* view-settings.js — import, backup, and housekeeping. */

import { h, clear, toast, sheet, confirmSheet, downloadFile, plural, fmtDate } from './ui.js';
import * as store from './store.js';
import * as db from './db.js';
import {
  parseGoodreads, looksLikeGoodreads, mergeGoodreadsInto, matchKey,
} from './goodreads.js';
import {
  lookupIsbn, searchBooks, plausibleMatch, findCover, netStats, resetNetStats,
  cooldownRemaining, clearCooldown,
} from './lookup.js';
import { prefs, setPref } from './prefs.js';
import { applyTheme } from './theme.js';
import { VERSION, BUILT } from './version.js';

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

      h('section', { class: 'card' },
        h('h3', { class: 'card__title' }, 'App version'),
        h('p', { class: 'version' }, `Version ${VERSION}`,
          h('span', { class: 'muted tiny' }, ` · built ${BUILT}`)),
        h('p', { class: 'muted tiny' },
          'If this number is lower than the one you just uploaded, your phone is still '
          + 'running the old copy. Tap below — it fetches the new files and restarts the app. '
          + 'Your books are not affected.'),
        h('button', {
          class: 'btn btn--ghost btn--block', type: 'button', id: 'update-btn',
          onclick: (e) => checkForUpdate(e.currentTarget),
        }, 'Check for updates')
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

/* ---------- updating ---------- */

/**
 * Pull down new files and restart on them, without the "close it twice and
 * hope" dance. Tells the waiting service worker to take over immediately,
 * then reloads once it has.
 */
async function checkForUpdate(btn) {
  const original = btn.textContent;
  btn.textContent = 'Checking…';
  btn.disabled = true;

  // However it goes, don't leave the button spinning forever.
  const bail = setTimeout(() => window.location.reload(), 12000);

  try {
    if (!('serviceWorker' in navigator)) { window.location.reload(); return; }

    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) { window.location.reload(); return; }

    // Reload as soon as the new worker takes control.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      clearTimeout(bail);
      window.location.reload();
    }, { once: true });

    await reg.update();

    if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    else if (!reg.installing) {
      // Already on the newest worker — nothing to hand over to.
      clearTimeout(bail);
      btn.disabled = false;
      btn.textContent = original;
      toast(`Already up to date (version ${VERSION}).`);
    }
  } catch (_) {
    clearTimeout(bail);
    btn.disabled = false;
    btn.textContent = original;
    toast('Could not check for updates — are you online?', { error: true });
  }
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

  const { books, total, skipped, ownershipKnown, inferredDates } = parseGoodreads(text);
  if (!books.length) {
    toast('No books found in that file.', { error: true });
    return;
  }

  // Match the CSV against what's already here, by ISBN where possible.
  const byKey = new Map(store.all().map((b) => [matchKey(b), b]));
  const fresh = [];
  const updates = [];
  for (const incoming of books) {
    const existing = byKey.get(matchKey(incoming));
    if (!existing) { fresh.push(incoming); continue; }
    const { book, changed } = mergeGoodreadsInto(existing, incoming);
    if (changed.length) updates.push({ book, changed });
  }
  const untouched = books.length - fresh.length - updates.length;

  // What would updating actually fill in? Say so rather than "trust me".
  const tally = {};
  for (const u of updates) for (const field of u.changed) tally[field] = (tally[field] || 0) + 1;
  const FIELD_LABEL = {
    dates: 'reading dates', owned: 'whether you own it', genres: 'genres',
    rating: 'ratings', review: 'reviews', notes: 'private notes', tags: 'shelf tags',
    series: 'series', seriesIndex: 'series numbers', year: 'publication years',
    pageCount: 'page counts', publisher: 'publishers', isbn13: 'ISBNs', isbn10: 'ISBNs',
  };
  const fillSummary = Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .map(([field, n]) => `${n} ${FIELD_LABEL[field] || field}`);

  const counts = fresh.reduce((acc, b) => { acc[b.status] = (acc[b.status] || 0) + 1; return acc; }, {});

  const body = h('div', {},
    h('p', {}, `Found ${plural(books.length, 'book')} in ${plural(total, 'row')}.`),

    fresh.length
      ? h('ul', { class: 'bullets' },
        Object.entries(counts).map(([k, v]) => h('li', {}, `${v} new → ${db.STATUS_LABEL[k] || k}`)))
      : h('p', { class: 'muted' }, 'Nothing in this file is new to your shelves.'),

    updates.length
      ? h('div', {},
        h('p', {}, `${plural(updates.length, 'book')} you already have could be filled in:`),
        h('ul', { class: 'bullets' }, fillSummary.map((line) => h('li', {}, line))),
        h('p', { class: 'muted tiny' },
          'Gap-filling only. Ratings, reviews, dates and shelves you have changed in the '
          + 'app are never overwritten.'))
      : null,

    untouched ? h('p', { class: 'muted' }, `${plural(untouched, 'book')} already complete — nothing to change.`) : null,
    skipped ? h('p', { class: 'muted' }, `${plural(skipped, 'row')} had no title and were ignored.`) : null,
    h('p', { class: 'muted' }, ownershipKnown
      ? `${fresh.filter((b) => b.owned).length} of the new ones are marked as owned in your export.`
      : 'Your export has no ownership information (Goodreads\u2019 \u201cOwned Copies\u201d was never used), so nothing is marked owned or not.'),
    inferredDates
      ? h('p', { class: 'muted' },
        `${plural(inferredDates, 'book')} have no Date Read in the export, so the date you `
        + 'added them to Goodreads is used instead. Those show with a \u2248 in the reading '
        + 'history \u2014 edit any one to confirm or correct it.')
      : null,
    h('p', { class: 'muted tiny' }, 'Covers are not in the export \u2014 fetch them afterwards from Settings.')
  );

  const applyImport = async ({ withUpdates }) => {
    if (fresh.length) await store.saveMany(fresh);
    if (withUpdates && updates.length) await store.saveMany(updates.map((u) => u.book));
    const bits = [];
    if (fresh.length) bits.push(`added ${plural(fresh.length, 'book')}`);
    if (withUpdates && updates.length) bits.push(`updated ${updates.length}`);
    toast(bits.length ? `Imported \u2014 ${bits.join(', ')}` : 'Nothing to do.');
    renderSettings(document.getElementById('view'));
  };

  const actions = [{ label: 'Cancel' }];
  if (fresh.length) {
    actions.push({
      label: updates.length ? `Add ${fresh.length} only` : `Import ${fresh.length}`,
      variant: updates.length ? undefined : 'primary',
      onClick: () => applyImport({ withUpdates: false }),
    });
  }
  if (updates.length) {
    actions.push({
      label: fresh.length ? `Add + fill in ${updates.length}` : `Fill in ${updates.length}`,
      variant: 'primary',
      onClick: () => applyImport({ withUpdates: true }),
    });
  }

  sheet('Import from Goodreads', body, { actions });
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
  // An unverified coverUrl counts as missing: it may be a guess that 404s.
  return store.all().filter((b) =>
    (!b.hasCover && !b.coverVerified) || !(b.genres || []).length);
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
    clearCooldown();   // don't make Stop wait out a backoff
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

  resetNetStats();
  const counts = { done: 0, updated: 0, notFound: 0 };
  let gaveUp = false;

  const paint = () => {
    bar.style.width = `${Math.round((counts.done / list.length) * 100)}%`;
    const waiting = cooldownRemaining();
    status.textContent =
      `${counts.done} of ${list.length} · ${counts.updated} updated`
      + (counts.notFound ? ` · ${counts.notFound} no match` : '')
      + (waiting > 500 ? ` · easing off for ${Math.ceil(waiting / 1000)}s` : '');
  };
  paint();
  const ticker = setInterval(paint, 1000);

  await runPool(list, async (book) => {
    if (enrichAbort || gaveUp) return;
    let outcome = 'notfound';
    try {
      outcome = await enrichOne(book);
    } catch (_) {
      outcome = 'notfound';
    }

    counts.done++;
    if (outcome === 'updated') counts.updated++;
    else if (outcome === 'notfound') counts.notFound++;

    // Only give up when the network itself is clearly unusable — nothing has
    // succeeded at all and requests keep erroring. Being rate-limited is NOT
    // a reason to stop; the backoff in lookup.js handles that by slowing down.
    if (netStats.ok === 0 && netStats.networkErrors >= 20) {
      gaveUp = true;
      enrichAbort = true;
    }
    // Being throttled is survivable; being throttled with nothing getting
    // through is not. The backoff climbs to a minute a request, so grinding
    // through hundreds of books would take hours for nothing.
    if (netStats.ok === 0 && netStats.rateLimited >= 6) {
      clearCooldown();
      enrichAbort = true;
    }
    paint();
  }, { concurrency: 3 });

  clearInterval(ticker);

  if (gaveUp) {
    status.textContent = navigator.onLine === false
      ? 'Your phone is offline — this needs a connection. Try again when you’re back on wifi.'
      : 'Every request failed, which usually means no connection (or wifi that needs a login). '
        + 'Nothing was changed; try again later and it picks up where it left off.';
  } else if (netStats.ok === 0 && netStats.rateLimited > 0) {
    status.textContent = `Open Library and Google Books turned away every request `
      + `(${netStats.rateLimited} refusals). That's rate limiting, not a problem with your `
      + `books — wait ten minutes and run it again.`;
  } else if (enrichAbort) {
    status.textContent = `Stopped. ${counts.updated} updated, ${counts.done} of ${list.length} checked.`;
  } else {
    status.textContent = `Done. ${counts.updated} updated`
      + (counts.notFound ? `, ${counts.notFound} had no match online` : '')
      + (netStats.rateLimited ? `. Slowed down ${netStats.rateLimited} times to stay within `
        + 'the free services\u2019 limits — running it again will pick up any that were skipped.' : '.');
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

  const needCover = !current.hasCover && !current.coverVerified;
  const needMeta = !(current.genres || []).length;
  const isbn = current.isbn13 || current.isbn10;

  let changed = false;
  let found = null;

  // Metadata first, but only if something is actually missing.
  if (needMeta) {
    found = isbn ? await lookupIsbn(isbn) : null;
    if (!found) {
      const query = [current.title, (current.authors || [])[0]].filter(Boolean).join(' ');
      const hits = query ? await searchBooks(query, { limit: 3 }) : [];
      found = hits.find((hit) => plausibleMatch(current, hit)) || null;
    }
  }

  const patch = { ...current };
  if (found) {
    if (!patch.genres?.length && found.genres?.length) { patch.genres = found.genres; changed = true; }
    if (!patch.authors?.length && found.authors?.length) { patch.authors = found.authors; changed = true; }
    for (const k of ['series', 'seriesIndex', 'year', 'pageCount', 'publisher', 'description', 'subtitle']) {
      if ((patch[k] == null || patch[k] === '') && found[k]) { patch[k] = found[k]; changed = true; }
    }
  }

  // Covers get their own hunt across both services and other editions,
  // regardless of whether the metadata step found anything.
  if (needCover) {
    const cover = await findCover(patch, found);
    if (cover) {
      patch.coverUrl = cover.url;
      patch.coverVerified = true;
      changed = true;
      if (cover.blob) {
        await store.save(patch);
        await store.setCover(patch.id, cover.blob);
        return 'updated';
      }
    }
  }

  if (changed) await store.save(patch);
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
