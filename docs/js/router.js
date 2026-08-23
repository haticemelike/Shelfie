/* router.js — hash routing, so the iPhone back swipe does the right thing. */

const routes = new Map();
let current = null;
let onChange = null;

export function defineRoute(name, handler) {
  routes.set(name, handler);
}

export function setRouteListener(fn) {
  onChange = fn;
}

export function go(name, param) {
  const hash = param ? `#/${name}/${encodeURIComponent(param)}` : `#/${name}`;
  if (location.hash === hash) {
    dispatch();
    return;
  }
  location.hash = hash;
}

export function back(fallback = 'library') {
  if (history.length > 1) history.back();
  else go(fallback);
}

export function currentRoute() {
  return current;
}

function parse() {
  const raw = (location.hash || '').replace(/^#\/?/, '');
  const [name, param] = raw.split('/');
  return { name: name || 'library', param: param ? decodeURIComponent(param) : null };
}

function dispatch() {
  const { name, param } = parse();
  const handler = routes.get(name) || routes.get('library');
  current = { name: routes.has(name) ? name : 'library', param };
  handler(param);
  if (onChange) onChange(current);
}

export function startRouter() {
  window.addEventListener('hashchange', dispatch);
  dispatch();
}
