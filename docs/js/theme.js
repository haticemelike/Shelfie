/* theme.js — light/dark, following the phone unless told otherwise. */

import { prefs } from './prefs.js';

export function applyTheme() {
  const root = document.documentElement;
  if (prefs.theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', prefs.theme);

  // Keep the iOS status bar / browser chrome in step with the page.
  const dark = prefs.theme === 'dark'
    || (prefs.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
  }
  meta.content = dark ? '#171310' : '#f7f2e9';
}

export function watchSystemTheme() {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => { if (prefs.theme === 'auto') applyTheme(); };
  if (mq.addEventListener) mq.addEventListener('change', handler);
  else if (mq.addListener) mq.addListener(handler);
}
