/* view-stats.js — a small, honest reading dashboard. */

import { h, clear, emptyState, plural } from './ui.js';
import * as store from './store.js';
import { go } from './router.js';
import { openBook } from './view-book.js';
import { coverNode } from './covers.js';
import { starsText } from './view-library.js';
import { setStatFilter } from './statfilter.js';

export function renderStats(container) {
  clear(container);

  if (!store.count()) {
    container.append(emptyState('📈', 'Nothing to count yet',
      'Add a few books and this fills in.',
      h('button', { class: 'btn btn--primary', onclick: () => go('add') }, 'Add a book')));
    return;
  }

  const s = store.stats();
  const thisYear = new Date().getFullYear();
  const thisYearCount = (s.byYear.find(([y]) => y === thisYear) || [0, 0])[1];

  container.append(
    h('div', { class: 'stats' },
      h('p', { class: 'muted tiny stats__hint' }, 'Tap any figure to see the books behind it.'),

      h('div', { class: 'tiles' },
        tile(s.total, 'books', store.all()),
        tile(s.owned, 'on your shelves', store.all().filter((b) => b.owned === true)),
        tile(thisYearCount, `finished in ${thisYear}`, finishedIn(thisYear)),
        tile(s.byStatus.tbr, 'on the TBR', store.all().filter((b) => b.status === 'tbr')),
        tile(s.rereads, s.rereads === 1 ? 'reread' : 'rereads',
          store.all().filter((b) => store.isReread(b))),
        tile(s.avgRating ? s.avgRating.toFixed(1) : '—', 'average rating',
          store.all().filter((b) => b.rating)),
        tile(s.pagesRead ? s.pagesRead.toLocaleString() : '—', 'pages read',
          store.all().filter((b) => b.pageCount && store.finishedCount(b)))
      ),

      s.byYear.length ? yearChart(s.byYear) : null,

      shelfBreakdown(s),

      topRated()
    )
  );
}

/**
 * Every figure is a doorway: tapping one opens the shelves filtered to exactly
 * the books it counted. `books` is the actual list behind the number, so what
 * you see can never disagree with what you tapped.
 */
function tile(value, label, books) {
  if (!books || !books.length) {
    return h('div', { class: 'tile' },
      h('span', { class: 'tile__value' }, String(value)),
      h('span', { class: 'tile__label' }, label)
    );
  }
  return h('button', {
    class: 'tile tile--tappable',
    type: 'button',
    'aria-label': `${value} ${label} — show them`,
    onclick: () => showBooks(label, books),
  },
    h('span', { class: 'tile__value' }, String(value)),
    h('span', { class: 'tile__label' }, label),
    h('span', { class: 'tile__go', 'aria-hidden': 'true' }, '›')
  );
}

function showBooks(label, books) {
  setStatFilter(label, books.map((b) => b.id));
  go('library');
}

/** Books with at least one reading session finished in the given year. */
function finishedIn(year) {
  return store.all().filter((b) => (b.sessions || []).some((sess) =>
    sess.finish && new Date(sess.finish).getFullYear() === year));
}

function yearChart(byYear) {
  const rows = byYear.slice(0, 8);
  const max = Math.max(...rows.map(([, n]) => n), 1);
  return h('section', { class: 'card' },
    h('h3', { class: 'card__title' }, 'Books finished each year'),
    h('div', { class: 'bars' }, rows.map(([year, n]) =>
      h('button', {
        class: 'bars__row bars__row--tappable', type: 'button',
        'aria-label': `${n} books finished in ${year} — show them`,
        onclick: () => showBooks(`Finished in ${year}`, finishedIn(year)),
      },
        h('span', { class: 'bars__label' }, String(year)),
        h('div', { class: 'bars__track' },
          h('div', { class: 'bars__fill', style: { width: `${(n / max) * 100}%` } })),
        h('span', { class: 'bars__value' }, String(n))
      )))
  );
}

function shelfBreakdown(s) {
  const rows = [
    ['Reading', s.byStatus.reading, 'reading'],
    ['Read', s.byStatus.read, 'read'],
    ['TBR', s.byStatus.tbr, 'tbr'],
    ['DNF', s.byStatus.dnf, 'dnf'],
  ];
  const total = rows.reduce((a, [, n]) => a + n, 0) || 1;
  return h('section', { class: 'card' },
    h('h3', { class: 'card__title' }, 'Shelves'),
    h('div', { class: 'bars' }, rows.map(([label, n, status]) =>
      h('button', {
        class: 'bars__row bars__row--tappable', type: 'button',
        'aria-label': `${n} books on the ${label} shelf — show them`,
        onclick: () => showBooks(label, store.all().filter((b) => b.status === status)),
      },
        h('span', { class: 'bars__label' }, label),
        h('div', { class: 'bars__track' },
          h('div', { class: 'bars__fill bars__fill--alt', style: { width: `${(n / total) * 100}%` } })),
        h('span', { class: 'bars__value' }, String(n))
      ))),
    h('p', { class: 'muted tiny' },
      `${plural(s.seriesCount, 'series', 'series')} · ${plural(s.authorCount, 'author')}`),
    h('p', { class: 'muted tiny' },
      s.ownUnset
        ? `${s.owned} owned · ${s.unowned} not owned · ${s.ownUnset} not said yet`
        : `${s.owned} owned · ${s.unowned} read but not owned`)
  );
}

function topRated() {
  const best = store.all()
    .filter((b) => b.rating >= 4.5)
    .sort((a, b) => (b.rating - a.rating) || String(b.dateAdded).localeCompare(String(a.dateAdded)))
    .slice(0, 12);
  if (!best.length) return null;
  return h('section', { class: 'card' },
    h('h3', { class: 'card__title' }, 'Your favourites'),
    h('div', { class: 'grid grid--sm' }, best.map((b) =>
      h('button', { class: 'gbook', type: 'button', onclick: () => openBook(b.id) },
        h('div', { class: 'gbook__art' }, coverNode(b)),
        h('div', { class: 'gbook__meta' },
          h('span', { class: 'gbook__title' }, b.title),
          h('span', { class: 'gbook__rating' }, starsText(b.rating))
        ))))
  );
}
