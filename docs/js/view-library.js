/* view-library.js — the shelves. Two looks, same data. */

import {
  h, clear, $, debounce, emptyState, authorLine, toast, sheet, confirmSheet, plural,
} from './ui.js';
import { coverNode } from './covers.js';
import * as store from './store.js';
import { STATUS_LABEL, STATUSES } from './db.js';
import { prefs, setPref } from './prefs.js';
import { openBook } from './view-book.js';
import { go } from './router.js';
import { setBookOrder } from './nav.js';

let root = null;
let query = '';

/* Selection mode: tap to toggle, or drag a finger across covers to paint a
 * run of them. Kept as ids rather than elements so a re-render doesn't lose
 * the selection. */
let selecting = false;
const selected = new Set();

export function renderLibrary(container) {
  root = container;
  clear(root);
  query = '';
  selecting = false;
  selected.clear();

  root.append(
    h('div', { class: 'lib' },
      buildControls(),
      h('div', { class: 'lib__results', id: 'lib-results' })
    )
  );

  renderResults();
}

/* ---------- controls ---------- */

function buildControls() {
  const searchInput = h('input', {
    class: 'search__input',
    type: 'search',
    id: 'lib-search',
    placeholder: 'Search title, author, series…',
    autocomplete: 'off',
    autocorrect: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search',
    oninput: debounce((e) => { query = e.target.value; renderResults(); }, 180),
  });

  const bar = h('div', { class: 'lib__controls' },
    h('div', { class: 'search' },
      h('span', { class: 'search__icon', 'aria-hidden': 'true' }, '⌕'),
      searchInput
    ),
    h('div', { class: 'chips chips--scroll' },
      ownedChip(),
      h('span', { class: 'chips__divider', 'aria-hidden': 'true' }),
      statusChip('all', 'All'),
      statusChip('reading', 'Reading'),
      statusChip('tbr', 'TBR'),
      statusChip('read', 'Read'),
      statusChip('dnf', 'DNF'),
      statusChip('favorites', '★ Favourites')
    ),
    h('div', { class: 'lib__row2' },
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Group by' },
        ...store.GROUPINGS.map((g) => h('button', {
          class: 'seg__btn' + (prefs.groupBy === g ? ' is-on' : ''),
          type: 'button',
          onclick: () => { setPref('groupBy', g); refreshControls(); renderResults(); },
        }, store.GROUPING_LABEL[g]))
      ),
      h('button', {
        class: 'icon-btn icon-btn--bordered',
        id: 'sort-btn',
        type: 'button',
        'aria-label': 'Sort books',
        title: 'Sort',
        onclick: () => sortSheet(),
      }, '↕'),
      h('button', {
        class: 'icon-btn icon-btn--bordered',
        id: 'view-btn',
        type: 'button',
        'aria-label': prefs.view === 'shelf' ? 'Switch to grid view' : 'Switch to shelf view',
        title: prefs.view === 'shelf' ? 'Grid view' : 'Shelf view',
        onclick: () => {
          setPref('view', prefs.view === 'shelf' ? 'grid' : 'shelf');
          refreshControls();
          renderResults();
        },
      }, prefs.view === 'shelf' ? '▦' : '▤'),
      h('button', {
        class: 'icon-btn icon-btn--bordered' + (selecting ? ' is-on' : ''),
        id: 'select-btn',
        type: 'button',
        'aria-label': selecting ? 'Leave selection mode' : 'Select several books',
        title: 'Select',
        onclick: () => toggleSelectMode(),
      }, '☑')
    )
  );
  return bar;
}

/* ---------- sorting (built long ago in store.js, never surfaced until now) ---------- */

function sortSheet() {
  const body = h('div', { class: 'menu' },
    ...Object.entries(store.SORTS).map(([key, def]) => h('button', {
      class: 'menu__item' + (prefs.sort === key ? ' menu__item--on' : ''),
      type: 'button',
      onclick: () => { setPref('sort', key); refreshControls(); renderResults(); },
    }, h('span', { class: 'menu__icon' }, prefs.sort === key ? '✓' : ''), def.label))
  );
  sheet('Sort books by', body);
}

/* Ownership filters independently of status, so this chip cycles its own
 * three states rather than joining the single-select status group. */
const OWNED_CYCLE = { any: 'owned', owned: 'unowned', unowned: 'any' };
const OWNED_LABEL = { any: 'Any copy', owned: '📗 On my shelf', unowned: '👻 Don’t own' };

function ownedChip() {
  return h('button', {
    class: 'chip chip--owned' + (prefs.owned !== 'any' ? ' is-on' : ''),
    type: 'button',
    'aria-label': `Ownership filter: ${OWNED_LABEL[prefs.owned]}. Tap to change.`,
    onclick: () => { setPref('owned', OWNED_CYCLE[prefs.owned]); refreshControls(); renderResults(); },
  }, OWNED_LABEL[prefs.owned]);
}

function statusChip(value, label) {
  return h('button', {
    class: 'chip' + (prefs.status === value ? ' is-on' : ''),
    type: 'button',
    onclick: () => { setPref('status', value); refreshControls(); renderResults(); },
  }, label);
}

function refreshControls() {
  const old = $('.lib__controls', root);
  if (!old) return;
  const fresh = buildControls();
  const input = fresh.querySelector('#lib-search');
  input.value = query;
  old.replaceWith(fresh);
}

/* ---------- results ---------- */

export function renderResults() {
  // Safe to call when the shelves aren't on screen — e.g. a store update
  // arriving while the user is on a book page, or before the first render.
  if (!root || !root.isConnected) return;
  const box = $('#lib-results', root);
  if (!box) return;
  clear(box);

  if (!store.count()) {
    box.append(emptyState('📚', 'Your shelves are empty',
      'Scan a barcode to add your first book — or import a Goodreads export from Settings.',
      h('button', { class: 'btn btn--primary', onclick: () => go('add') }, 'Scan a book')));
    return;
  }

  let list = store.filterByOwned(prefs.owned, store.filterByStatus(prefs.status));
  if (query.trim()) list = store.search(query, list);

  if (!list.length) {
    box.append(emptyState('🔍', 'Nothing matches',
      query.trim()
        ? `No books for “${query.trim()}”.`
        : prefs.owned !== 'any'
          ? 'Nothing here with that combination of shelf and ownership.'
          : 'No books with that status yet.'));
    return;
  }

  // When searching, a flat ranked list beats grouping — relevance is the point.
  const groups = query.trim()
    ? [{ key: 'results', label: `${list.length} result${list.length === 1 ? '' : 's'}`, books: list }]
    : store.group(prefs.groupBy, list);

  if (selecting) box.append(bulkBar());

  for (const g of groups) {
    box.append(renderGroup(g));
  }

  // Order the book page will swipe through — exactly what's on screen now.
  setBookOrder(visibleIds(), 'library');
  if (selecting) attachPainting(box);
  box.classList.toggle('is-selecting', selecting);

  const ownedShown = list.filter((b) => b.owned === true).length;
  box.append(h('p', { class: 'lib__count' },
    `${list.length} of ${store.count()} book${store.count() === 1 ? '' : 's'}`,
    prefs.owned === 'any' && ownedShown
      ? h('span', { class: 'muted' }, ` · ${ownedShown} on your shelves`)
      : null));
}

function renderGroup(g) {
  const showHeader = !(prefs.groupBy === 'shelf' && g.key === 'all' && !query.trim());
  const section = h('section', { class: 'group' });

  if (showHeader) {
    const owned = g.books.filter((b) => b.owned === true).length;
    section.append(
      h('header', { class: 'group__head' },
        h('h2', { class: 'group__title' }, g.label),
        h('span', {
          class: 'group__count',
          title: owned && owned !== g.books.length ? `${owned} of these are on your shelves` : null,
        },
          g.books.length,
          owned && owned !== g.books.length && prefs.owned === 'any'
            ? h('span', { class: 'group__count-own' }, ` (${owned} owned)`)
            : null)
      )
    );
  }

  // Grouping decides the buckets; the sort control decides the order inside
  // them. "Author" keeps each group's natural order (series number, etc).
  const sorter = store.SORTS[prefs.sort];
  const books = sorter && prefs.sort !== 'author' ? sorter.fn(g.books) : g.books;

  section.append(
    prefs.view === 'shelf'
      ? h('div', { class: 'shelf' }, books.map((b) => shelfBook(b)))
      : h('div', { class: 'grid' }, books.map((b) => gridBook(b)))
  );
  return section;
}

/* ---------- book tiles ---------- */

function shelfBook(book) {
  const tile = h('button', {
    class: 'sbook' + (book.owned === false ? ' is-unowned' : '')
      + (selected.has(book.id) ? ' is-picked' : ''),
    type: 'button',
    dataset: { id: book.id },
    'aria-label': `${book.title} by ${authorLine(book)}${book.owned === false ? ' — not on your shelves' : ''}`,
    'aria-pressed': selecting ? String(selected.has(book.id)) : null,
    onclick: () => onTileTap(book.id),
  },
    coverNode(book),
    statusFlag(book),
    book.favorite ? h('span', { class: 'sbook__fav', 'aria-hidden': 'true' }, '★') : null,
    selecting ? h('span', { class: 'tick', 'aria-hidden': 'true' },
      selected.has(book.id) ? '✓' : '') : null
  );
  addLongPress(tile, book.id);
  return tile;
}

function gridBook(book) {
  const tile = h('button', {
    class: 'gbook' + (book.owned === false ? ' is-unowned' : '')
      + (selected.has(book.id) ? ' is-picked' : ''),
    type: 'button',
    dataset: { id: book.id },
    'aria-pressed': selecting ? String(selected.has(book.id)) : null,
    onclick: () => onTileTap(book.id),
  },
    h('div', { class: 'gbook__art' }, coverNode(book), statusFlag(book)),
    h('div', { class: 'gbook__meta' },
      h('span', { class: 'gbook__title' }, book.title),
      h('span', { class: 'gbook__author muted' }, authorLine(book)),
      book.rating ? h('span', { class: 'gbook__rating' }, starsText(book.rating)) : null,
      book.series
        ? h('span', { class: 'gbook__series muted' },
          book.series + (book.seriesIndex != null ? ` #${book.seriesIndex}` : ''))
        : null
    ),
    selecting ? h('span', { class: 'tick', 'aria-hidden': 'true' },
      selected.has(book.id) ? '✓' : '') : null
  );
  addLongPress(tile, book.id);
  return tile;
}

function statusFlag(book) {
  if (book.status === 'read' && !store.isReread(book)) {
    return h('span', { class: 'flag flag--read', title: 'Read' }, '✓');
  }
  if (book.status === 'read' && store.isReread(book)) {
    return h('span', { class: 'flag flag--reread', title: `Read ${store.finishedCount(book)} times` },
      '↻' + store.finishedCount(book));
  }
  if (book.status === 'reading') return h('span', { class: 'flag flag--reading', title: 'Reading' }, '▸');
  if (book.status === 'dnf') return h('span', { class: 'flag flag--dnf', title: 'Did not finish' }, '✕');
  if (book.status === 'tbr') return h('span', { class: 'flag flag--tbr', title: STATUS_LABEL.tbr }, '•');
  return null;
}

/* ---------- selection mode ---------- */

function toggleSelectMode(on = !selecting) {
  selecting = on;
  if (!selecting) selected.clear();
  refreshControls();
  renderResults();
}

function onTileTap(id) {
  if (!selecting) { openBook(id); return; }
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  paintTile(id);
  refreshBulkBar();
}

/** Long-press a cover to enter selection mode with that book already picked. */
function addLongPress(tile, id) {
  let timer = null;
  const cancel = () => { clearTimeout(timer); timer = null; };

  tile.addEventListener('touchstart', () => {
    if (selecting) return;
    timer = setTimeout(() => {
      timer = null;
      selected.add(id);
      if (navigator.vibrate) { try { navigator.vibrate(30); } catch (_) { /* iOS ignores */ } }
      toggleSelectMode(true);
    }, 450);
  }, { passive: true });

  tile.addEventListener('touchmove', cancel, { passive: true });
  tile.addEventListener('touchend', cancel, { passive: true });
  tile.addEventListener('contextmenu', (e) => { if (selecting) e.preventDefault(); });
}

/** Repaint one tile without rebuilding the whole list. */
function paintTile(id) {
  if (!root) return;
  for (const el of root.querySelectorAll(`[data-id="${CSS.escape(id)}"]`)) {
    const on = selected.has(id);
    el.classList.toggle('is-picked', on);
    el.setAttribute('aria-pressed', String(on));
    const tick = el.querySelector('.tick');
    if (tick) tick.textContent = on ? '✓' : '';
  }
}

/**
 * Drag a finger across covers to select a run of them.
 *
 * The first tile you touch decides the direction — if it was unselected you're
 * painting on, if it was selected you're rubbing out — so a stray wobble
 * doesn't flip books back and forth. Auto-scrolls near the screen edges so a
 * long run doesn't need repeated swipes.
 */
function attachPainting(box) {
  let painting = false;
  let mode = true;
  let lastId = null;
  let scrollTimer = null;
  let edgeSpeed = 0;

  const tileAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el && el.closest ? el.closest('[data-id]') : null;
  };

  const stopScroll = () => {
    if (scrollTimer) { cancelAnimationFrame(scrollTimer); scrollTimer = null; }
    edgeSpeed = 0;
  };

  const runScroll = () => {
    if (!painting || !edgeSpeed) { stopScroll(); return; }
    window.scrollBy(0, edgeSpeed);
    scrollTimer = requestAnimationFrame(runScroll);
  };

  box.addEventListener('touchstart', (e) => {
    if (!selecting || e.touches.length !== 1) return;
    const tile = tileAt(e.touches[0].clientX, e.touches[0].clientY);
    if (!tile) return;
    painting = true;
    lastId = tile.dataset.id;
    mode = !selected.has(lastId);   // paint on, or rub out
  }, { passive: true });

  box.addEventListener('touchmove', (e) => {
    if (!painting || e.touches.length !== 1) return;
    const t = e.touches[0];
    // We're painting, not scrolling — keep the page still under the finger.
    if (e.cancelable) e.preventDefault();

    const tile = tileAt(t.clientX, t.clientY);
    if (tile && tile.dataset.id !== lastId) {
      lastId = tile.dataset.id;
      if (mode) selected.add(lastId); else selected.delete(lastId);
      paintTile(lastId);
      refreshBulkBar();
    }

    // Near an edge? Creep the list along so long runs stay reachable.
    const EDGE = 90;
    const top = t.clientY;
    const bottom = window.innerHeight - t.clientY;
    if (top < EDGE) edgeSpeed = -Math.ceil((EDGE - top) / 6);
    else if (bottom < EDGE) edgeSpeed = Math.ceil((EDGE - bottom) / 6);
    else edgeSpeed = 0;
    if (edgeSpeed && !scrollTimer) scrollTimer = requestAnimationFrame(runScroll);
    if (!edgeSpeed) stopScroll();
  }, { passive: false });

  const end = () => {
    if (!painting) return;
    painting = false;
    lastId = null;
    stopScroll();
  };
  box.addEventListener('touchend', end, { passive: true });
  box.addEventListener('touchcancel', end, { passive: true });
}

/* ---------- bulk action bar ---------- */

function bulkBar() {
  const n = selected.size;
  return h('div', { class: 'bulkbar', id: 'bulk-bar' },
    h('div', { class: 'bulkbar__head' },
      h('strong', {}, n ? `${plural(n, 'book')} selected` : 'Select books'),
      h('button', {
        class: 'linkish', type: 'button',
        onclick: () => {
          const ids = visibleIds();
          if (selected.size >= ids.length) selected.clear();
          else ids.forEach((id) => selected.add(id));
          renderResults();
        },
      }, selected.size >= visibleIds().length && visibleIds().length ? 'Select none' : 'Select all'),
      h('button', { class: 'linkish', type: 'button', onclick: () => toggleSelectMode(false) }, 'Done')
    ),
    h('p', { class: 'muted tiny' },
      n ? 'Now pick what to change below.' : 'Tap covers, or drag a finger across them.'),
    h('div', { class: 'bulkbar__actions' },
      bulkBtn('📗 Own', n, () => applyBulk({ owned: true }, 'Marked as owned')),
      bulkBtn('👻 Don’t own', n, () => applyBulk({ owned: false }, 'Marked as not owned')),
      ...STATUSES.map((st) =>
        bulkBtn(STATUS_LABEL[st], n, () => applyStatusBulk(st))),
      bulkBtn('★ Favourite', n, () => applyBulk({ favorite: true }, 'Added to favourites')),
      bulkBtn('🗑 Delete', n, () => deleteBulk(), 'danger')
    )
  );
}

function bulkBtn(label, enabled, onClick, variant) {
  return h('button', {
    class: 'btn btn--sm' + (variant === 'danger' ? ' btn--danger' : ''),
    type: 'button',
    disabled: !enabled,
    onclick: onClick,
  }, label);
}

function visibleIds() {
  if (!root) return [];
  return [...new Set([...root.querySelectorAll('[data-id]')].map((el) => el.dataset.id))];
}

function refreshBulkBar() {
  const old = $('#bulk-bar', root);
  if (old) old.replaceWith(bulkBar());
}

async function applyBulk(patch, message) {
  const ids = [...selected];
  await store.updateMany(ids, patch);
  toast(`${message} — ${plural(ids.length, 'book')}`);
  renderResults();
}

/** Status changes log dates, exactly as they do on a single book's page. */
async function applyStatusBulk(status) {
  const ids = [...selected];
  const day = new Date().toISOString().slice(0, 10);
  await store.updateMany(ids, (book) => {
    if (book.status === status) return null;
    const sessions = [...(book.sessions || [])];
    const openIdx = sessions.findIndex((x) => x.start && !x.finish && !x.finished && !x.dnfAt);
    const blank = () => ({
      id: crypto.randomUUID ? crypto.randomUUID() : 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      start: null, finish: null, finished: false, approx: false, dnfAt: null, format: '', note: '',
    });
    if (status === 'reading') {
      if (openIdx < 0) sessions.push({ ...blank(), start: day });
    } else if (status === 'read') {
      if (openIdx >= 0) sessions[openIdx] = { ...sessions[openIdx], finish: day, finished: true, dnfAt: null };
      else sessions.push({ ...blank(), finish: day, finished: true });
    } else if (status === 'dnf') {
      if (openIdx >= 0) sessions[openIdx] = { ...sessions[openIdx], dnfAt: day, finish: null, finished: false };
      else sessions.push({ ...blank(), dnfAt: day });
    }
    return { status, sessions };
  });
  toast(`Moved ${plural(ids.length, 'book')} to ${STATUS_LABEL[status]}`);
  renderResults();
}

async function deleteBulk() {
  const ids = [...selected];
  const ok = await confirmSheet(`Delete ${plural(ids.length, 'book')}?`,
    'They will be removed from this phone along with their ratings, reviews and dates. This cannot be undone.',
    { confirmLabel: `Delete ${ids.length}` });
  if (!ok) return;
  await store.removeMany(ids);
  selected.clear();
  toast(`Deleted ${plural(ids.length, 'book')}`);
  renderResults();
}

export function starsText(rating) {
  const full = Math.floor(rating);
  const half = rating - full >= 0.5;
  return '★'.repeat(full) + (half ? '½' : '');
}
