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
import { statFilter, clearStatFilter } from './statfilter.js';

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

  const results = h('div', { class: 'lib__results', id: 'lib-results' });
  root.append(h('div', { class: 'lib' }, buildControls(), results));

  // Once, and once only. This used to live in renderResults(), which runs on
  // every store change — so each render stacked another painting state machine
  // on the same element, and they fought each other for the same gesture.
  attachPainting(results);

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

  const bar = h('div', { class: 'lib__controls' + (statFilter() ? ' is-statfiltered' : '') },
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

  /* Arrived from a tapped figure on the Stats page: show exactly the books
   * that figure counted, and nothing else — the shelf/ownership chips would
   * only make the number disagree with the list. */
  const stat = statFilter();
  let list = stat
    ? store.all().filter((b) => stat.ids.has(b.id))
    : store.filterByOwned(prefs.owned, store.filterByStatus(prefs.status));
  if (query.trim()) list = store.search(query, list);

  if (!list.length) {
    box.append(emptyState('🔍', 'Nothing matches',
      query.trim()
        ? `No books for “${query.trim()}”.`
        : stat
          ? `Nothing left under “${stat.label}”.`
          : prefs.owned !== 'any'
            ? 'Nothing here with that combination of shelf and ownership.'
            : 'No books with that status yet.',
      stat ? h('button', {
        class: 'btn btn--primary', type: 'button',
        onclick: () => { clearStatFilter(); renderResults(); },
      }, 'Show all books') : null));
    return;
  }

  // When searching, a flat ranked list beats grouping — relevance is the point.
  const groups = query.trim()
    ? [{ key: 'results', label: `${list.length} result${list.length === 1 ? '' : 's'}`, books: list }]
    : store.group(prefs.groupBy, list);

  if (stat) {
    box.append(h('div', { class: 'statbar' },
      h('span', { class: 'statbar__label' },
        h('strong', {}, stat.label),
        h('span', { class: 'muted' }, ` · ${plural(list.length, 'book')}`)),
      h('button', {
        class: 'linkish', type: 'button',
        onclick: () => { clearStatFilter(); refreshControls(); renderResults(); },
      }, 'Show all ✕')
    ));
  }

  if (selecting) box.append(bulkBar());

  for (const g of groups) {
    box.append(renderGroup(g));
  }

  // Order the book page will swipe through — exactly what's on screen now.
  indexTiles(box);
  setBookOrder(orderedIds, 'library');
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
    copiesBadge(book),
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
    h('div', { class: 'gbook__art' }, coverNode(book), statusFlag(book), copiesBadge(book)),
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

/** Only shown when there's something to say — one copy is the normal case. */
function copiesBadge(book) {
  const n = book.copies || 1;
  if (n <= 1) return null;
  return h('span', { class: 'copies', title: `${n} copies` }, `×${n}`);
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

/* A drag ends with a synthetic click on the tile it started from. Without
 * this the starting book would be toggled twice — once by the drag, once by
 * that click — and appear not to respond at all. */
let dragEndedAt = 0;

function onTileTap(id) {
  if (Date.now() - dragEndedAt < 400) return;
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
  for (const el of tileIndex.get(id) || []) {
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
  let startId = null;
  let moved = false;
  let fingerX = 0;
  let fingerY = 0;
  let sampledX = 0;   // where the last sample was taken, for interpolation
  let sampledY = 0;
  let frame = null;
  let edgeSpeed = 0;
  let barDirty = false;

  /** Whatever tile is under the given point, if any. */
  const tileAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el && el.closest ? el.closest('[data-id]') : null;
  };

  const applyTile = (tile) => {
    if (!tile) return;
    const id = tile.dataset.id;
    if (id === lastId) return;
    lastId = id;
    if (mode) selected.add(id); else selected.delete(id);
    paintTile(id);
    barDirty = true;
  };

  /**
   * Paint everything the finger passed over since the last frame.
   *
   * Sampling only the finger's current position misses tiles whenever the
   * finger travels more than one cover between animation frames — which is
   * most of the time at any natural speed, and is what made this feel like it
   * was ignoring half the gesture. So walk the line from where we last
   * sampled to where the finger is now.
   *
   * Also called from the scroll loop: holding still at the edge fires no
   * touchmove at all, so without it the covers creeping past went unpicked.
   */
  const sampleUnderFinger = () => {
    const dx = fingerX - sampledX;
    const dy = fingerY - sampledY;
    const distance = Math.hypot(dx, dy);

    // First real movement: this is a drag, not a tap, so the book you started
    // on flips too — otherwise dragging across a selected run leaves its first
    // book stubbornly behind.
    if (!moved && distance > 12) {
      moved = true;
      lastId = null;
      applyTile(tileAt(sampledX, sampledY));
    }
    const STEP = 20;                       // comfortably finer than a cover
    const steps = Math.min(Math.ceil(distance / STEP), 60);

    if (steps <= 1) {
      applyTile(tileAt(fingerX, fingerY));
    } else {
      for (let i = 1; i <= steps; i++) {
        applyTile(tileAt(sampledX + (dx * i) / steps, sampledY + (dy * i) / steps));
      }
    }
    sampledX = fingerX;
    sampledY = fingerY;
  };

  /* One animation frame does everything: scroll a step, sample, update the
   * count. Touch events only record where the finger is. Previously each
   * touchmove did a DOM rebuild and two full-tree scans, which stalled the
   * main thread badly enough that iOS started dropping the events. */
  const tick = () => {
    if (!painting) { frame = null; return; }
    if (edgeSpeed) {
      window.scrollBy(0, edgeSpeed);
      // The finger didn't move — the page did. Sample in place rather than
      // drawing a line through everything that scrolled past.
      sampledX = fingerX;
      sampledY = fingerY;
      lastId = null;
    }
    sampleUnderFinger();
    if (barDirty) { refreshBulkBar(); barDirty = false; }
    frame = requestAnimationFrame(tick);
  };

  const startFrames = () => { if (!frame) frame = requestAnimationFrame(tick); };

  /* Deciding between scrolling and painting.
   *
   * Covers used to be `touch-action: none` in selection mode, which meant the
   * page could only be scrolled from the gaps between them — unusable. Now
   * tiles allow vertical panning, and the FIRST movement of each gesture
   * decides: mostly sideways claims the gesture for painting, mostly up or
   * down leaves it to the browser to scroll, from anywhere on the screen.
   * Once painting has been claimed, the finger can go any direction it likes.
   */
  const CLAIM = 10;          // px of travel before we decide
  let deciding = false;      // touched a tile, direction not yet known
  let originX = 0;
  let originY = 0;

  box.addEventListener('touchstart', (e) => {
    if (!selecting || e.touches.length !== 1) return;
    const t = e.touches[0];
    const tile = tileAt(t.clientX, t.clientY);
    if (!tile) return;

    deciding = true;
    painting = false;
    originX = t.clientX;
    originY = t.clientY;
    fingerX = originX;
    fingerY = originY;
    sampledX = originX;
    sampledY = originY;
    startId = tile.dataset.id;
    // The first tile sets the direction — painting on, or rubbing out — so a
    // wobble later in the drag can't flip books back and forth.
    mode = !selected.has(startId);
    // Nothing is applied yet: this might be a plain tap, which the click
    // handler deals with, or a scroll. The claim below decides.
    lastId = startId;
    moved = false;
  }, { passive: true });

  box.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];

    if (deciding) {
      const dx = t.clientX - originX;
      const dy = t.clientY - originY;
      if (Math.abs(dx) < CLAIM && Math.abs(dy) < CLAIM) return;   // too early to tell
      deciding = false;
      if (Math.abs(dy) > Math.abs(dx)) return;                    // let it scroll
      painting = true;
      startFrames();
    }
    if (!painting) return;

    fingerX = t.clientX;
    fingerY = t.clientY;
    // We're painting, not scrolling: hold the page still under the finger.
    if (e.cancelable) e.preventDefault();

    const EDGE = 100;
    const fromTop = fingerY;
    const fromBottom = window.innerHeight - fingerY;
    if (fromTop < EDGE) edgeSpeed = -Math.max(4, Math.round((EDGE - fromTop) / 4));
    else if (fromBottom < EDGE) edgeSpeed = Math.max(4, Math.round((EDGE - fromBottom) / 4));
    else edgeSpeed = 0;

    startFrames();
  }, { passive: false });

  const end = () => {
    deciding = false;
    if (!painting) return;
    painting = false;
    if (moved) dragEndedAt = Date.now();
    lastId = null;
    startId = null;
    moved = false;
    edgeSpeed = 0;
    if (frame) { cancelAnimationFrame(frame); frame = null; }
    refreshBulkBar();
  };
  box.addEventListener('touchend', end, { passive: true });
  box.addEventListener('touchcancel', end, { passive: true });
}

/* ---------- bulk action bar ---------- */

function bulkBar() {
  const n = selected.size;
  return h('div', { class: 'bulkbar', id: 'bulk-bar' },
    h('div', { class: 'bulkbar__head' },
      h('strong', { class: 'bulkbar__count' }, n ? `${plural(n, 'book')} selected` : 'Select books'),
      h('button', {
        class: 'linkish bulkbar__all', type: 'button',
        onclick: () => {
          const ids = visibleIds();
          if (selected.size >= ids.length) selected.clear();
          else ids.forEach((id) => selected.add(id));
          renderResults();
        },
      }, selected.size >= visibleIds().length && visibleIds().length ? 'Select none' : 'Select all'),
      h('button', { class: 'linkish', type: 'button', onclick: () => toggleSelectMode(false) }, 'Done')
    ),
    h('p', { class: 'muted tiny bulkbar__hint' },
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

/* Built once per render. Painting a tile during a drag must not walk the
 * whole tree — with a few hundred books that alone drops frames. */
let tileIndex = new Map();   // id -> [elements]
let orderedIds = [];

function indexTiles(box) {
  tileIndex = new Map();
  orderedIds = [];
  for (const el of box.querySelectorAll('[data-id]')) {
    const id = el.dataset.id;
    if (!tileIndex.has(id)) { tileIndex.set(id, []); orderedIds.push(id); }
    tileIndex.get(id).push(el);
  }
}

function visibleIds() { return orderedIds; }

/**
 * Cheap in-place update. Rebuilding the whole bar on every tile the finger
 * crossed was the other half of the sluggishness — a DOM replacement plus two
 * full-tree scans per touchmove.
 */
function refreshBulkBar() {
  const bar = $('#bulk-bar', root);
  if (!bar) return;
  const n = selected.size;
  const label = bar.querySelector('.bulkbar__count');
  if (label) label.textContent = n ? `${plural(n, 'book')} selected` : 'Select books';
  const hint = bar.querySelector('.bulkbar__hint');
  if (hint) hint.textContent = n ? 'Now pick what to change below.' : 'Tap covers, or drag a finger across them.';
  for (const btn of bar.querySelectorAll('.bulkbar__actions .btn')) btn.disabled = !n;
  const all = bar.querySelector('.bulkbar__all');
  if (all) all.textContent = n && n >= visibleIds().length ? 'Select none' : 'Select all';
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
