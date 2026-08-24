/* view-book.js — one book: status, rating, review, and its reading history. */

import {
  h, clear, toast, sheet, confirmSheet, fmtDate, fmtDateInput,
  starRating, emptyState, plural,
} from './ui.js';
import { coverNode } from './covers.js';
import * as store from './store.js';
import { STATUSES, STATUS_LABEL } from './db.js';
import { go, back } from './router.js';
import { findCover, lookupIsbn } from './lookup.js';
import { neighbours } from './nav.js';

export function openBook(id) {
  go('book', id);
}

const today = () => new Date().toISOString().slice(0, 10);

function newSession(patch = {}) {
  return {
    id: crypto.randomUUID ? crypto.randomUUID() : 's' + Date.now().toString(36),
    start: null, finish: null, finished: false, dnfAt: null, format: '', note: '',
    ...patch,
  };
}

export function renderBook(container, id) {
  const book = store.get(id);
  clear(container);

  if (!book) {
    container.append(emptyState('🤷', 'Book not found',
      'It may have been deleted.',
      h('button', { class: 'btn btn--primary', onclick: () => go('library') }, 'Back to shelves')));
    return;
  }

  const rerender = () => renderBook(container, id);

  container.append(
    h('div', { class: 'book' },
      h('div', { class: 'book__topbar' },
        h('button', { class: 'linkish', type: 'button', onclick: () => back('library') }, '‹ Shelves'),
        h('div', { class: 'book__topactions' },
          h('button', {
            class: 'icon-btn' + (book.favorite ? ' is-fav' : ''),
            type: 'button',
            'aria-label': book.favorite ? 'Remove from favourites' : 'Add to favourites',
            onclick: async () => {
              await store.save({ ...book, favorite: !book.favorite });
              rerender();
            },
          }, book.favorite ? '★' : '☆'),
          h('button', {
            class: 'icon-btn', type: 'button', 'aria-label': 'More actions',
            onclick: () => moreActions(book, rerender),
          }, '⋯')
        )
      ),

      h('div', { class: 'book__hero' },
        h('div', { class: 'book__cover' }, coverNode(book)),
        h('div', { class: 'book__head' },
          h('h1', { class: 'book__title' }, book.title),
          book.subtitle ? h('p', { class: 'book__subtitle' }, book.subtitle) : null,
          h('p', { class: 'book__author' }, (book.authors || []).join(', ') || 'Unknown author'),
          book.series
            ? h('p', { class: 'book__series' },
              book.series + (book.seriesIndex != null ? ` · Book ${book.seriesIndex}` : ''))
            : null,
          h('p', { class: 'book__facts muted' }, factLine(book))
        )
      ),

      book.genres && book.genres.length
        ? h('div', { class: 'chips chips--static' },
          book.genres.map((g) => h('span', { class: 'chip chip--static' }, g)))
        : null,

      statusSection(book, rerender),
      ratingSection(book, rerender),
      reviewSection(book),
      historySection(book, rerender),

      book.description
        ? h('section', { class: 'card' },
          h('h3', { class: 'card__title' }, 'Description'),
          h('p', { class: 'book__desc' }, book.description))
        : null,

      h('section', { class: 'card card--quiet' },
        h('h3', { class: 'card__title' }, 'Details'),
        detailRows(book)),

      pager(id)
    )
  );

  attachSwipe(container, id);
}

/* ---------- moving between books ---------- */

/**
 * Swipe left/right to walk the list you arrived from — a series, a search
 * result, whichever shelf you were looking at — rather than some fixed order.
 */
function pager(id) {
  const { prev, next, index, total } = neighbours(id);
  if (total < 2) return null;
  return h('nav', { class: 'pager', 'aria-label': 'Move between books' },
    h('button', {
      class: 'pager__btn', type: 'button', disabled: !prev,
      onclick: () => prev && go('book', prev, { replace: true }),
    }, '‹ Previous'),
    h('span', { class: 'pager__count muted' }, `${index + 1} of ${total}`),
    h('button', {
      class: 'pager__btn', type: 'button', disabled: !next,
      onclick: () => next && go('book', next, { replace: true }),
    }, 'Next ›')
  );
}

function attachSwipe(container, id) {
  const { prev, next, total } = neighbours(id);
  if (total < 2) return;

  let startX = 0;
  let startY = 0;
  let tracking = false;

  container.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
  }, { passive: true });

  container.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    // Comfortably horizontal, and long enough not to be a stray thumb.
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 2) return;
    // Don't hijack a swipe that started inside something scrollable sideways.
    if (t.target.closest && t.target.closest('.chips--scroll, .sheet')) return;
    const target = dx < 0 ? next : prev;
    if (target) {
      container.classList.add(dx < 0 ? 'is-leaving-left' : 'is-leaving-right');
      go('book', target, { replace: true });
    }
  }, { passive: true });
}

function factLine(book) {
  const bits = [];
  if (book.year) bits.push(book.year);
  if (book.pageCount) bits.push(`${book.pageCount} pages`);
  if (book.publisher) bits.push(book.publisher);
  return bits.join(' · ');
}

/* ---------- status ---------- */

function statusSection(book, rerender) {
  return h('section', { class: 'card' },
    h('div', { class: 'seg seg--wide', role: 'group', 'aria-label': 'Reading status' },
      ...STATUSES.map((s) => h('button', {
        class: 'seg__btn' + (book.status === s ? ' is-on' : ''),
        type: 'button',
        onclick: () => changeStatus(book, s, rerender),
      }, STATUS_LABEL[s]))
    ),
    book.status === 'read'
      ? h('button', {
        class: 'btn btn--ghost btn--block',
        type: 'button',
        onclick: async () => {
          await store.addSession(book.id, { start: today() });
          await store.save({ ...store.get(book.id), status: 'reading' });
          toast('Reading again — new dates added, old ones kept.');
          rerender();
        },
      }, '↻ Read it again')
      : null,

    h('div', { class: 'ownrow' },
      h('span', { class: 'field__label' }, 'Do you have a copy?'),
      h('div', { class: 'seg' },
        ownBtn(book, true, '📗 On my shelf', rerender),
        ownBtn(book, false, 'Don’t own it', rerender)
      )
    )
  );
}

function ownBtn(book, value, label, rerender) {
  return h('button', {
    class: 'seg__btn' + (book.owned === value ? ' is-on' : ''),
    type: 'button',
    onclick: async () => {
      // Tapping the active one clears it back to "never said".
      await store.save({ ...book, owned: book.owned === value ? null : value });
      rerender();
    },
  }, label);
}

/**
 * Changing status logs dates rather than silently losing them.
 * An open session (started, not finished) is closed; otherwise a new one opens.
 */
async function changeStatus(book, status, rerender) {
  if (book.status === status) return;
  const sessions = [...(book.sessions || [])];
  const openIdx = sessions.findIndex((s) => s.start && !s.finish && !s.finished && !s.dnfAt);

  if (status === 'reading') {
    if (openIdx < 0) sessions.push(newSession({ start: today() }));
  } else if (status === 'read') {
    if (openIdx >= 0) sessions[openIdx] = { ...sessions[openIdx], finish: today(), finished: true, dnfAt: null };
    else sessions.push(newSession({ finish: today(), finished: true }));
  } else if (status === 'dnf') {
    if (openIdx >= 0) sessions[openIdx] = { ...sessions[openIdx], dnfAt: today(), finish: null, finished: false };
    else sessions.push(newSession({ dnfAt: today() }));
  }
  // Moving to TBR leaves history untouched — it's a plan, not an erasure.

  await store.save({ ...book, status, sessions });
  rerender();
}

/* ---------- rating ---------- */

function ratingSection(book, rerender) {
  return h('section', { class: 'card' },
    h('div', { class: 'card__rowhead' },
      h('h3', { class: 'card__title' }, 'Your rating'),
      h('span', { class: 'muted' }, book.rating ? `${book.rating} / 5` : 'Not rated')
    ),
    starRating(book.rating, async (v) => {
      await store.save({ ...book, rating: v });
      rerender();
    }, { size: 'lg' })
  );
}

/* ---------- review ---------- */

function reviewSection(book) {
  const ta = h('textarea', {
    class: 'input input--area',
    rows: 5,
    placeholder: 'What did you think?',
    oninput: (e) => { e.target.dataset.dirty = '1'; },
  });
  ta.value = book.review || '';

  const status = h('span', { class: 'muted tiny' }, '');
  const commit = async () => {
    if (ta.dataset.dirty !== '1') return;
    ta.dataset.dirty = '';
    await store.save({ ...store.get(book.id), review: ta.value });
    status.textContent = 'Saved';
    setTimeout(() => { status.textContent = ''; }, 1500);
  };
  ta.addEventListener('blur', commit);
  window.addEventListener('pagehide', commit);

  return h('section', { class: 'card' },
    h('div', { class: 'card__rowhead' },
      h('h3', { class: 'card__title' }, 'Review'),
      status
    ),
    ta
  );
}

/* ---------- reading history ---------- */

function historySection(book, rerender) {
  // Newest first; undated entries sink to the bottom.
  const sessions = [...(book.sessions || [])].sort((a, b) =>
    String(b.finish || b.dnfAt || b.start || '').localeCompare(String(a.finish || a.dnfAt || a.start || '')));

  const finished = store.finishedCount(book);

  return h('section', { class: 'card' },
    h('div', { class: 'card__rowhead' },
      h('h3', { class: 'card__title' }, 'Reading history'),
      finished > 1 ? h('span', { class: 'badge badge--reread' }, `Reread · ${plural(finished, 'time')}`) : null
    ),

    sessions.length
      ? h('ul', { class: 'sessions' }, sessions.map((s) => sessionRow(book, s, rerender)))
      : h('p', { class: 'muted' }, 'No dates logged yet.'),

    h('button', {
      class: 'btn btn--ghost btn--block',
      type: 'button',
      onclick: () => sessionSheet(book, null, rerender),
    }, '+ Add dates')
  );
}

function sessionRow(book, s, rerender) {
  // "≈" marks a date worked out from your Goodreads Date Added rather than
  // one you actually recorded.
  const about = s.approx ? '≈ ' : '';
  let label = '';
  let cls = '';
  if (s.finish) { label = `${about}Finished ${fmtDate(s.finish)}`; cls = 'ok'; }
  else if (s.finished) { label = 'Finished — date unknown'; cls = 'ok'; }
  else if (s.dnfAt) { label = `${about}Set aside ${fmtDate(s.dnfAt)}`; cls = 'dnf'; }
  else if (s.start) { label = `${about}Started ${fmtDate(s.start)}`; cls = 'open'; }
  else label = 'Undated';

  const sub = [];
  if (s.start && s.finish) sub.push(`${fmtDate(s.start)} → ${fmtDate(s.finish)}`);
  if (s.format) sub.push(s.format);
  if (s.note) sub.push(s.note);

  return h('li', { class: `session session--${cls}` },
    h('button', {
      class: 'session__main', type: 'button',
      onclick: () => sessionSheet(book, s, rerender),
    },
      h('span', { class: 'session__label' }, label),
      sub.length ? h('span', { class: 'session__sub muted' }, sub.join(' · ')) : null
    ),
    h('button', {
      class: 'icon-btn icon-btn--sm', type: 'button', 'aria-label': 'Delete these dates',
      onclick: async () => {
        if (await confirmSheet('Delete these dates?', 'This removes one entry from the reading history.')) {
          await store.removeSession(book.id, s.id);
          rerender();
        }
      },
    }, '🗑')
  );
}

function sessionSheet(book, existing, rerender) {
  const start = h('input', { class: 'input', type: 'date', max: today() });
  const finish = h('input', { class: 'input', type: 'date', max: today() });
  const dnf = h('input', { class: 'input', type: 'date', max: today() });
  const format = h('input', { class: 'input', type: 'text', placeholder: 'Paperback, ebook, audiobook…' });
  const note = h('input', { class: 'input', type: 'text', placeholder: 'Anything worth remembering' });
  const finishedBox = h('input', { class: 'checkbox', type: 'checkbox' });

  if (existing) {
    start.value = fmtDateInput(existing.start);
    finish.value = fmtDateInput(existing.finish);
    dnf.value = fmtDateInput(existing.dnfAt);
    format.value = existing.format || '';
    note.value = existing.note || '';
    finishedBox.checked = !!(existing.finished || existing.finish);
  } else {
    finish.value = today();
    finishedBox.checked = true;
  }

  // Ticking a finish date obviously means you finished it.
  finish.addEventListener('change', () => { if (finish.value) finishedBox.checked = true; });

  const body = h('div', { class: 'form' },
    existing && existing.approx
      ? h('p', { class: 'muted tiny' },
        'This date was worked out from when you added the book to Goodreads, '
        + 'not from a date you recorded. Saving marks it as confirmed.')
      : null,
    field('Started', start),
    field('Finished', finish),
    h('label', { class: 'check' }, finishedBox,
      h('span', {}, 'I finished it (tick this even if you can’t remember when)')),
    field('Set aside (DNF)', dnf),
    field('Format', format),
    field('Note', note)
  );

  sheet(existing ? 'Edit dates' : 'Add dates', body, {
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save',
        variant: 'primary',
        onClick: async () => {
          const patch = {
            start: start.value || null,
            finish: finish.value || null,
            finished: finishedBox.checked,
            // You've just looked at these dates and saved them — no longer a guess.
            approx: false,
            dnfAt: dnf.value || null,
            format: format.value.trim(),
            note: note.value.trim(),
          };
          if (existing) await store.updateSession(book.id, existing.id, patch);
          else await store.addSession(book.id, patch);

          // Keep the headline status honest with the dates just entered.
          const fresh = store.get(book.id);
          let status = fresh.status;
          if (patch.finished || patch.finish) status = 'read';
          else if (patch.dnfAt) status = 'dnf';
          else if (patch.start) status = 'reading';
          if (status !== fresh.status) await store.save({ ...fresh, status });

          rerender();
        },
      },
    ],
  });
}

function field(label, input) {
  return h('label', { class: 'field' }, h('span', { class: 'field__label' }, label), input);
}

/* ---------- details table ---------- */

function detailRows(book) {
  const rows = [
    ['ISBN', book.isbn13 || book.isbn10 || '—'],
    ['Series', book.series ? book.series + (book.seriesIndex != null ? ` #${book.seriesIndex}` : '') : '—'],
    ['Genres', (book.genres || []).join(', ') || '—'],
    ['Pages', book.pageCount || '—'],
    ['Published', book.year || '—'],
    ['Publisher', book.publisher || '—'],
    ['Added', fmtDate(book.dateAdded)],
  ];
  return h('dl', { class: 'dl' }, rows.map(([k, v]) =>
    [h('dt', {}, k), h('dd', {}, String(v))]));
}

/* ---------- overflow menu ---------- */

function moreActions(book, rerender) {
  // Each item closes this menu before doing its thing — otherwise the next
  // sheet opens on top of it and you're looking at two stacked panels.
  const body = h('div', { class: 'menu' });
  const close = sheet(book.title, body);

  const item = (icon, label, onClick, variant) => h('button', {
    class: 'menu__item' + (variant ? ' menu__item--' + variant : ''),
    type: 'button',
    onclick: () => { close(); setTimeout(onClick, 180); },
  }, h('span', { class: 'menu__icon' }, icon), label);

  body.append(
    item('✎', 'Edit details', () => editSheet(book, rerender)),
    item('⭯', 'Refresh info from the internet', () => refetch(book, rerender)),
    item('🖼', 'Replace cover', () => replaceCover(book, rerender)),
    item('🗑', 'Delete book', async () => {
      if (await confirmSheet('Delete this book?', `“${book.title}” will be removed from your library. This cannot be undone.`)) {
        await store.remove(book.id);
        toast('Deleted');
        go('library');
      }
    }, 'danger')
  );
}

function editSheet(book, rerender) {
  const f = {
    title: h('input', { class: 'input', value: book.title }),
    subtitle: h('input', { class: 'input', value: book.subtitle || '' }),
    authors: h('input', { class: 'input', value: (book.authors || []).join(', '), placeholder: 'Comma separated' }),
    series: h('input', { class: 'input', value: book.series || '', list: 'known-series' }),
    seriesIndex: h('input', { class: 'input', type: 'number', step: '0.5', value: book.seriesIndex ?? '' }),
    genres: h('input', { class: 'input', value: (book.genres || []).join(', '), placeholder: 'Comma separated', list: 'known-genres' }),
    year: h('input', { class: 'input', type: 'number', value: book.year ?? '' }),
    pageCount: h('input', { class: 'input', type: 'number', value: book.pageCount ?? '' }),
    publisher: h('input', { class: 'input', value: book.publisher || '' }),
    isbn13: h('input', { class: 'input', value: book.isbn13 || '', inputmode: 'numeric' }),
  };

  const body = h('div', { class: 'form' },
    field('Title', f.title),
    field('Subtitle', f.subtitle),
    field('Authors', f.authors),
    field('Series', f.series),
    field('Number in series', f.seriesIndex),
    field('Genres', f.genres),
    field('Year', f.year),
    field('Pages', f.pageCount),
    field('Publisher', f.publisher),
    field('ISBN', f.isbn13),
    datalist('known-series', store.knownValues('series')),
    datalist('known-genres', unionGenres())
  );

  sheet('Edit details', body, {
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save',
        variant: 'primary',
        onClick: async () => {
          await store.save({
            ...store.get(book.id),
            title: f.title.value.trim() || book.title,
            subtitle: f.subtitle.value.trim(),
            authors: splitList(f.authors.value),
            series: f.series.value.trim(),
            seriesIndex: f.seriesIndex.value === '' ? null : Number(f.seriesIndex.value),
            genres: splitList(f.genres.value),
            year: f.year.value === '' ? null : Number(f.year.value),
            pageCount: f.pageCount.value === '' ? null : Number(f.pageCount.value),
            publisher: f.publisher.value.trim(),
            isbn13: f.isbn13.value.trim() || null,
          });
          toast('Saved');
          rerender();
        },
      },
    ],
  });
}

function datalist(id, values) {
  return h('datalist', { id }, values.map((v) => h('option', { value: v })));
}

const COMMON_GENRES = ['Fantasy', 'Science Fiction', 'Horror', 'Mystery', 'Thriller', 'Romance',
  'Historical Fiction', 'Literary Fiction', 'Young Adult', 'Graphic Novel', 'Poetry', 'Classics',
  'Short Stories', 'Memoir', 'Biography', 'History', 'Science', 'Philosophy', 'Psychology',
  'Self-Help', 'Essays', 'True Crime', 'Nature', 'Art', 'Cookbook'];

function unionGenres() {
  return [...new Set([...store.knownValues('genres'), ...COMMON_GENRES])].sort();
}

export function splitList(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

async function refetch(book, rerender) {
  const isbn = book.isbn13 || book.isbn10;
  if (!isbn) { toast('No ISBN on this book to look up.', { error: true }); return; }
  toast('Looking it up…');
  const found = await lookupIsbn(isbn);
  if (!found) { toast('Nothing found for that ISBN.', { error: true }); return; }
  // Only fill gaps — never clobber corrections already made by hand.
  const merged = { ...store.get(book.id) };
  for (const k of ['subtitle', 'series', 'seriesIndex', 'year', 'pageCount', 'publisher', 'description', 'coverUrl']) {
    const empty = merged[k] == null || merged[k] === '';
    if (empty && found[k]) merged[k] = found[k];
  }
  if (!merged.genres?.length && found.genres?.length) merged.genres = found.genres;
  if (!merged.authors?.length && found.authors?.length) merged.authors = found.authors;
  await store.save(merged);
  if (!merged.hasCover && !merged.coverVerified) {
    const cover = await findCover(merged, found);
    if (cover) {
      if (cover.blob) await store.setCover(merged.id, cover.blob);
      await store.save({ ...store.get(merged.id), coverUrl: cover.url, coverVerified: true });
    }
  }
  toast('Updated');
  rerender();
}

function replaceCover(book, rerender) {
  /* `capture` was the bug: on iOS it forces the camera and removes the photo
   * library option entirely. Two separate inputs instead — one plain (which
   * offers Photo Library, Take Photo and Browse) and one that goes straight to
   * the camera for when that's what you want. */
  const pick = h('input', {
    type: 'file', accept: 'image/*', class: 'file-input', id: 'cover-pick',
  });
  const shoot = h('input', {
    type: 'file', accept: 'image/*', capture: 'environment',
    class: 'file-input', id: 'cover-shoot',
  });

  const preview = h('div', { class: 'coverpick__preview' },
    h('p', { class: 'muted tiny' }, 'No image chosen yet.'));
  let chosen = null;

  const onPicked = async (input) => {
    const file = input.files && input.files[0];
    if (!file) return;
    chosen = await shrinkImage(file, 700);
    clear(preview);
    const url = URL.createObjectURL(chosen);
    preview.append(h('img', {
      class: 'coverpick__img', src: url, alt: 'Chosen cover',
      onload: () => setTimeout(() => URL.revokeObjectURL(url), 1000),
    }));
  };
  pick.addEventListener('change', () => onPicked(pick));
  shoot.addEventListener('change', () => onPicked(shoot));

  const body = h('div', { class: 'form' },
    h('label', { class: 'btn btn--primary btn--block', for: 'cover-pick' }, '🖼 Choose from Photos'),
    pick,
    h('label', { class: 'btn btn--ghost btn--block', for: 'cover-shoot' }, '📷 Take a photo'),
    shoot,
    preview
  );

  sheet('Replace cover', body, {
    actions: [
      { label: 'Cancel' },
      {
        label: 'Use image',
        variant: 'primary',
        onClick: async () => {
          if (!chosen) { toast('Choose or take an image first.', { error: true }); return true; }
          await store.setCover(book.id, chosen);
          // A hand-picked cover is definitive — stop the fetcher second-guessing it.
          await store.save({ ...store.get(book.id), coverVerified: true });
          toast('Cover updated');
          rerender();
        },
      },
    ],
  });
}

/** Photos off an iPhone are ~4MB; a cover only needs to be ~700px tall. */
export async function shrinkImage(file, maxHeight = 700) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxHeight / bitmap.height);
    const w = Math.round(bitmap.width * scale);
    const hgt = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = hgt;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, hgt);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.82));
    bitmap.close?.();
    return blob || file;
  } catch (_) {
    return file;
  }
}
