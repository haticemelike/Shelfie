/* statfilter.js — "show me the books behind this number".
 *
 * Tapping a figure on the Stats page hands the shelves an explicit set of book
 * ids plus a label. Ids rather than a predicate, deliberately: the number you
 * tapped and the books you get are then guaranteed to be the same set, even if
 * the definition of a stat changes later.
 */

let active = null;   // { label, ids: Set<string> }

export function setStatFilter(label, ids) {
  active = { label, ids: new Set(ids) };
}

export function statFilter() { return active; }

export function clearStatFilter() { active = null; }
