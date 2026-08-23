/* ui.js — tiny DOM helpers. No framework, no build step. */

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(4)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/* ---------- toast ---------- */

let toastTimer = null;
export function toast(message, { error = false, ms = 2600 } = {}) {
  let box = $('#toast');
  if (!box) {
    box = h('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(box);
  }
  box.textContent = message;
  box.classList.toggle('toast--error', !!error);
  box.classList.add('toast--on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('toast--on'), ms);
}

/* ---------- modal sheet ---------- */

export function sheet(title, contentNode, { actions = [] } = {}) {
  const backdrop = h('div', { class: 'sheet-backdrop' });
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });

  const close = () => {
    backdrop.classList.remove('on');
    setTimeout(() => backdrop.remove(), 200);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  panel.append(
    h('div', { class: 'sheet__grab' }),
    h('header', { class: 'sheet__head' },
      h('h2', {}, title),
      h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, '✕')
    ),
    h('div', { class: 'sheet__body' }, contentNode),
    actions.length
      ? h('footer', { class: 'sheet__foot' },
        actions.map((a) => h('button', {
          class: 'btn ' + (a.variant ? 'btn--' + a.variant : ''),
          onclick: async () => {
            const keep = await a.onClick?.(close);
            if (!keep) close();
          },
        }, a.label)))
      : null
  );

  backdrop.append(panel);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.body.append(backdrop);
  requestAnimationFrame(() => backdrop.classList.add('on'));
  return close;
}

export function confirmSheet(title, message, { confirmLabel = 'Delete', danger = true } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    sheet(title, h('p', { class: 'muted' }, message), {
      actions: [
        { label: 'Cancel', onClick: () => { answered = true; resolve(false); } },
        {
          label: confirmLabel,
          variant: danger ? 'danger' : 'primary',
          onClick: () => { answered = true; resolve(true); },
        },
      ],
    });
    // If the user swipes the sheet away, treat it as "no".
    const observer = new MutationObserver(() => {
      if (!document.querySelector('.sheet-backdrop') && !answered) {
        answered = true;
        observer.disconnect();
        resolve(false);
      }
    });
    observer.observe(document.body, { childList: true });
  });
}

/* ---------- formatting ---------- */

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtDateInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

export function authorLine(book) {
  const a = book.authors || [];
  if (!a.length) return 'Unknown author';
  if (a.length <= 2) return a.join(' & ');
  return `${a[0]} & ${a.length - 1} others`;
}

export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || one + 's'}`;
}

/* ---------- star rating ---------- */

/** Interactive 5-star control with half steps. onChange(value|null) */
export function starRating(value, onChange, { size = 'md', readonly = false } = {}) {
  const wrap = h('div', {
    class: `stars stars--${size}` + (readonly ? ' stars--readonly' : ''),
    role: readonly ? 'img' : 'group',
    'aria-label': value ? `${value} out of 5 stars` : 'Not rated',
  });

  const render = (v) => {
    clear(wrap);
    for (let i = 1; i <= 5; i++) {
      const filled = v >= i ? 'full' : (v >= i - 0.5 ? 'half' : 'empty');
      const star = h('span', { class: `star star--${filled}`, 'aria-hidden': 'true' }, '★');
      if (!readonly) {
        const hit = h('button', {
          class: 'star-hit',
          type: 'button',
          'aria-label': `${i} stars`,
          onclick: (e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const half = (e.clientX - rect.left) < rect.width / 2;
            let next = half ? i - 0.5 : i;
            if (next === v) next = null; // tap the same spot to clear
            render(next);
            onChange(next);
          },
        });
        hit.append(star);
        wrap.append(hit);
      } else {
        wrap.append(star);
      }
    }
    if (!readonly) {
      wrap.append(h('button', {
        class: 'stars__clear',
        type: 'button',
        onclick: () => { render(null); onChange(null); },
      }, 'Clear'));
    }
  };

  render(value);
  return wrap;
}

/* ---------- misc ---------- */

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function downloadFile(filename, content, type = 'application/json') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
}

export function spinner(label = 'Loading…') {
  return h('div', { class: 'spinner-box' }, h('div', { class: 'spinner' }), h('p', { class: 'muted' }, label));
}

export function emptyState(icon, title, body, action) {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty__icon' }, icon),
    h('h3', {}, title),
    body ? h('p', { class: 'muted' }, body) : null,
    action || null
  );
}
