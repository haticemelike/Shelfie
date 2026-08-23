/* covers.js — cover images, with a decent-looking fallback when there is none. */

import { getCover } from './db.js';
import { h } from './ui.js';

const urlCache = new Map(); // bookId -> objectURL

export function revokeCover(bookId) {
  const u = urlCache.get(bookId);
  if (u) {
    URL.revokeObjectURL(u);
    urlCache.delete(bookId);
  }
}

export function revokeAll() {
  for (const u of urlCache.values()) URL.revokeObjectURL(u);
  urlCache.clear();
}

async function coverObjectUrl(bookId) {
  if (urlCache.has(bookId)) return urlCache.get(bookId);
  const blob = await getCover(bookId);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(bookId, url);
  return url;
}

/* A stable, pleasant colour per book so placeholders don't all look the same. */
const PALETTE = [
  ['#8c5a3c', '#6b4229'], ['#3f5b6b', '#2c4150'], ['#6b3f52', '#4e2c3c'],
  ['#4a6b47', '#35502f'], ['#6b5f3f', '#50472c'], ['#4b436b', '#352f50'],
  ['#6b4a3f', '#50352c'], ['#3f6b64', '#2c504a'],
];

function hashOf(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

export function placeholderCover(book) {
  const [a, b] = PALETTE[hashOf(book.title + (book.authors?.[0] || '')) % PALETTE.length];
  return h('div', {
    class: 'cover cover--placeholder',
    style: { background: `linear-gradient(150deg, ${a}, ${b})` },
  },
    h('span', { class: 'cover__ph-title' }, book.title),
    h('span', { class: 'cover__ph-author' }, (book.authors || [])[0] || '')
  );
}

/**
 * Returns a node that shows the cover. Resolution order:
 *   1. the blob we saved on the phone (works offline)
 *   2. the remote URL (if the publisher's host blocked our download)
 *   3. a generated placeholder
 */
export function coverNode(book, { alt = true } = {}) {
  const box = h('div', { class: 'cover-box' });
  const ph = placeholderCover(book);
  box.append(ph);

  const show = (src) => {
    const img = h('img', {
      class: 'cover',
      src,
      alt: alt ? `Cover of ${book.title}` : '',
      loading: 'lazy',
      decoding: 'async',
    });
    img.addEventListener('load', () => { ph.remove(); });
    img.addEventListener('error', () => { img.remove(); });
    box.append(img);
  };

  if (book.hasCover) {
    coverObjectUrl(book.id).then((url) => {
      if (url) show(url);
      else if (book.coverUrl) show(book.coverUrl);
    });
  } else if (book.coverUrl) {
    show(book.coverUrl);
  }

  return box;
}
