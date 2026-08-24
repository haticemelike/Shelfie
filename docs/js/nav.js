/* nav.js — remembers the order books are currently shown in, so the book page
 * can swipe to the next one in the list you actually came from (a series, a
 * search result, the TBR shelf) rather than some global ordering.
 *
 * Also remembers scroll position per screen: with a few hundred books, being
 * thrown back to the top every time you close a book is miserable.
 */

let order = [];
let source = '';

export function setBookOrder(ids, from = '') {
  order = Array.isArray(ids) ? ids.slice() : [];
  source = from;
}

export function bookOrder() { return order; }
export function orderSource() { return source; }

/** Where a book sits in the current list, or -1 if it isn't in one. */
export function indexOf(id) {
  return order.indexOf(id);
}

export function neighbours(id) {
  const i = order.indexOf(id);
  if (i < 0) return { prev: null, next: null, index: -1, total: 0 };
  return {
    prev: i > 0 ? order[i - 1] : null,
    next: i < order.length - 1 ? order[i + 1] : null,
    index: i,
    total: order.length,
  };
}

/* ---------- scroll memory ---------- */

const scrollByRoute = new Map();

export function rememberScroll(routeName) {
  if (!routeName) return;
  scrollByRoute.set(routeName, window.scrollY || 0);
}

export function restoreScroll(routeName) {
  const y = scrollByRoute.get(routeName);
  // Two frames: one for the DOM to be in place, one for images to reserve space.
  requestAnimationFrame(() => {
    window.scrollTo(0, y || 0);
    requestAnimationFrame(() => window.scrollTo(0, y || 0));
  });
}

export function forgetScroll(routeName) {
  scrollByRoute.delete(routeName);
}
