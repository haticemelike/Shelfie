/* view-library.js — the shelves. Two looks, same data. */

import { h, clear, $, debounce, emptyState, authorLine } from './ui.js';
import { coverNode } from './covers.js';
import * as store from './store.js';
import { STATUS_LABEL } from './db.js';
import { prefs, setPref } from './prefs.js';
import { openBook } from './view-book.js';
import { go } from './router.js';

let root = null;
let query = '';

export function renderLibrary(container) {
  root = container;
  clear(root);
  query = '';

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
        type: 'button',
        'aria-label': prefs.view === 'shelf' ? 'Switch to grid view' : 'Switch to shelf view',
        title: prefs.view === 'shelf' ? 'Grid view' : 'Shelf view',
        onclick: () => {
          setPref('view', prefs.view === 'shelf' ? 'grid' : 'shelf');
          refreshControls();
          renderResults();
        },
      }, prefs.view === 'shelf' ? '▦' : '▤')
    )
  );
  return bar;
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
  const box = $('#lib-results', root);
  if (!box) return;
  clear(box);

  if (!store.count()) {
    box.append(emptyState('📚', 'Your shelves are empty',
      'Scan a barcode to add your first book — or import a Goodreads export from Settings.',
      h('button', { class: 'btn btn--primary', onclick: () => go('add') }, 'Scan a book')));
    return;
  }

  let list = store.filterByStatus(prefs.status);
  if (query.trim()) list = store.search(query, list);

  if (!list.length) {
    box.append(emptyState('🔍', 'Nothing matches',
      query.trim() ? `No books for “${query.trim()}”.` : 'No books with that status yet.'));
    return;
  }

  // When searching, a flat ranked list beats grouping — relevance is the point.
  const groups = query.trim()
    ? [{ key: 'results', label: `${list.length} result${list.length === 1 ? '' : 's'}`, books: list }]
    : store.group(prefs.groupBy, list);

  for (const g of groups) {
    box.append(renderGroup(g));
  }

  box.append(h('p', { class: 'lib__count muted' },
    `${list.length} of ${store.count()} book${store.count() === 1 ? '' : 's'}`));
}

function renderGroup(g) {
  const showHeader = !(prefs.groupBy === 'shelf' && g.key === 'all' && !query.trim());
  const section = h('section', { class: 'group' });

  if (showHeader) {
    section.append(
      h('header', { class: 'group__head' },
        h('h2', { class: 'group__title' }, g.label),
        h('span', { class: 'group__count' }, g.books.length)
      )
    );
  }

  section.append(
    prefs.view === 'shelf'
      ? h('div', { class: 'shelf' }, g.books.map((b) => shelfBook(b)))
      : h('div', { class: 'grid' }, g.books.map((b) => gridBook(b)))
  );
  return section;
}

/* ---------- book tiles ---------- */

function shelfBook(book) {
  const tile = h('button', {
    class: 'sbook',
    type: 'button',
    'aria-label': `${book.title} by ${authorLine(book)}`,
    onclick: () => openBook(book.id),
  },
    coverNode(book),
    statusFlag(book),
    book.favorite ? h('span', { class: 'sbook__fav', 'aria-hidden': 'true' }, '★') : null
  );
  return tile;
}

function gridBook(book) {
  return h('button', {
    class: 'gbook',
    type: 'button',
    onclick: () => openBook(book.id),
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
    )
  );
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

export function starsText(rating) {
  const full = Math.floor(rating);
  const half = rating - full >= 0.5;
  return '★'.repeat(full) + (half ? '½' : '');
}
