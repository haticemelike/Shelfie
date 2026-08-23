/* view-stats.js — a small, honest reading dashboard. */

import { h, clear, emptyState, plural } from './ui.js';
import * as store from './store.js';
import { go } from './router.js';
import { openBook } from './view-book.js';
import { coverNode } from './covers.js';
import { starsText } from './view-library.js';

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
      h('div', { class: 'tiles' },
        tile(s.total, 'books'),
        tile(thisYearCount, `finished in ${thisYear}`),
        tile(s.byStatus.tbr, 'on the TBR'),
        tile(s.rereads, s.rereads === 1 ? 'reread' : 'rereads'),
        tile(s.avgRating ? s.avgRating.toFixed(1) : '—', 'average rating'),
        tile(s.pagesRead ? s.pagesRead.toLocaleString() : '—', 'pages read')
      ),

      s.byYear.length ? yearChart(s.byYear) : null,

      shelfBreakdown(s),

      topRated()
    )
  );
}

function tile(value, label) {
  return h('div', { class: 'tile' },
    h('span', { class: 'tile__value' }, String(value)),
    h('span', { class: 'tile__label' }, label)
  );
}

function yearChart(byYear) {
  const rows = byYear.slice(0, 8);
  const max = Math.max(...rows.map(([, n]) => n), 1);
  return h('section', { class: 'card' },
    h('h3', { class: 'card__title' }, 'Books finished each year'),
    h('div', { class: 'bars' }, rows.map(([year, n]) =>
      h('div', { class: 'bars__row' },
        h('span', { class: 'bars__label' }, String(year)),
        h('div', { class: 'bars__track' },
          h('div', { class: 'bars__fill', style: { width: `${(n / max) * 100}%` } })),
        h('span', { class: 'bars__value' }, String(n))
      )))
  );
}

function shelfBreakdown(s) {
  const rows = [
    ['Reading', s.byStatus.reading],
    ['Read', s.byStatus.read],
    ['TBR', s.byStatus.tbr],
    ['DNF', s.byStatus.dnf],
  ];
  const total = rows.reduce((a, [, n]) => a + n, 0) || 1;
  return h('section', { class: 'card' },
    h('h3', { class: 'card__title' }, 'Shelves'),
    h('div', { class: 'bars' }, rows.map(([label, n]) =>
      h('div', { class: 'bars__row' },
        h('span', { class: 'bars__label' }, label),
        h('div', { class: 'bars__track' },
          h('div', { class: 'bars__fill bars__fill--alt', style: { width: `${(n / total) * 100}%` } })),
        h('span', { class: 'bars__value' }, String(n))
      ))),
    h('p', { class: 'muted tiny' },
      `${plural(s.seriesCount, 'series', 'series')} · ${plural(s.authorCount, 'author')}`)
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
