/* app.js — boot, tab bar, routing. */

import { h, clear, $, toast } from './ui.js';
import * as store from './store.js';
import { requestPersistence } from './db.js';
import { defineRoute, startRouter, setRouteListener, go, currentRoute } from './router.js';
import { renderLibrary, renderResults } from './view-library.js';
import { renderBook } from './view-book.js';
import { renderAdd, leaveAdd } from './view-add.js';
import { renderStats } from './view-stats.js';
import { renderSettings, loadNetworkSettings } from './view-settings.js';
import { applyTheme, watchSystemTheme } from './theme.js';
import { rememberScroll, restoreScroll } from './nav.js';

const TABS = [
  { name: 'library', label: 'Shelves', icon: '📚' },
  { name: 'add', label: 'Add', icon: '＋' },
  { name: 'stats', label: 'Stats', icon: '📈' },
  { name: 'settings', label: 'Settings', icon: '⚙' },
];

let view = null;
let lastRoute = null;

async function boot() {
  applyTheme();
  watchSystemTheme();

  view = $('#view');
  buildTabBar();

  try {
    await store.load();
  } catch (e) {
    view.append(h('div', { class: 'card' },
      h('h3', {}, 'Could not open the library'),
      h('p', { class: 'muted' }, String(e.message || e)),
      h('p', { class: 'muted tiny' }, 'If you are in a Private Browsing tab, iOS blocks storage. Open the app in a normal tab.')));
    return;
  }

  // Ask iOS to treat our data as worth keeping. Harmless if it says no.
  requestPersistence();

  // Restore the optional Google key and any cooldown left over from last time.
  await loadNetworkSettings();

  defineRoute('library', () => renderLibrary(view));
  defineRoute('book', (id) => renderBook(view, id));
  defineRoute('add', () => renderAdd(view));
  defineRoute('stats', () => renderStats(view));
  defineRoute('settings', () => renderSettings(view));

  setRouteListener((route) => {
    // Free the camera the moment we navigate away from Add.
    if (lastRoute && lastRoute.name === 'add' && route.name !== 'add') leaveAdd();
    lastRoute = route;
    highlightTab(route.name);

    // Coming back to the shelves after 340 books shouldn't dump you at the top.
    if (route.name === 'library') restoreScroll('library');
    else window.scrollTo(0, 0);
  });

  // Capture where the shelves were before any navigation away from them.
  window.addEventListener('hashchange', () => {
    if (lastRoute && lastRoute.name === 'library') rememberScroll('library');
  }, { capture: true });

  startRouter();
  registerServiceWorker();

  // Keep the shelves in step if a book changes while they're on screen.
  store.subscribe(() => {
    const r = currentRoute();
    if (r && r.name === 'library') renderResults();
  });

  document.body.classList.remove('booting');
}

function buildTabBar() {
  const bar = $('#tabbar');
  clear(bar);
  for (const t of TABS) {
    bar.append(h('button', {
      class: 'tab',
      type: 'button',
      dataset: { tab: t.name },
      onclick: () => go(t.name),
    },
      h('span', { class: 'tab__icon', 'aria-hidden': 'true' }, t.icon),
      h('span', { class: 'tab__label' }, t.label)
    ));
  }
}

function highlightTab(name) {
  const active = name === 'book' ? 'library' : name;
  for (const el of document.querySelectorAll('.tab')) {
    el.classList.toggle('is-on', el.dataset.tab === active);
    if (el.dataset.tab === active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol === 'file:') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url), { scope: './' })
      .catch(() => { /* offline support is a bonus, not a requirement */ });
  });
}

window.addEventListener('online', () => toast('Back online'));

boot();
