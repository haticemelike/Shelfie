/* lookup.js — turn an ISBN (or a title/author guess) into a book record.
 *
 * Sources, both free and key-free:
 *   Open Library  — good at series, editions, page counts
 *   Google Books  — good at clean categories, subtitles, descriptions
 * We query both and merge, preferring whichever has the better field.
 */

const OL = 'https://openlibrary.org';
const OL_COVERS = 'https://covers.openlibrary.org';
const GB = 'https://www.googleapis.com/books/v1/volumes';

/* Google refuses ALL unauthenticated Books requests with a 403 when it cannot
 * geolocate the caller's IP — common on phone carrier networks and IPv6, and
 * permanent until the parameter below is sent. It looks exactly like being
 * rate-limited, except it never goes away. The documented workaround is to
 * state a country explicitly. It only scopes which editions are visible; it
 * sends nothing about the user.
 * https://groups.google.com/g/google-appengine/c/C-IoRG7Z7VI */
const TIMEOUT_MS = 9000;

/* ---------- per-host pacing ----------
 *
 * The previous version only slowed down AFTER being refused, and used a single
 * global cooldown — so Google's throttle stalled Open Library too, and a burst
 * of parallel requests tripped the limit before any backoff could react.
 *
 * Now each host has its own lane: a minimum gap between requests (so we stay
 * under the limit instead of discovering it), its own cooldown, and its own
 * exponential backoff. Requests to different hosts still overlap freely.
 *
 * Google's unauthenticated Books limit is per-IP and roughly one request a
 * second sustained; anything faster earns a 429 within a few dozen calls.
 */

const HOST_PACE = {
  'www.googleapis.com': 1100,
  'openlibrary.org': 400,
  'covers.openlibrary.org': 250,
};
const DEFAULT_PACE = 500;
const MAX_BACKOFF = 120000;

const lanes = new Map();

function laneFor(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch (_) { host = 'other'; }
  if (!lanes.has(host)) {
    lanes.set(host, {
      host,
      chain: Promise.resolve(),
      lastAt: 0,
      cooldownUntil: 0,
      backoff: 2000,
      pace: HOST_PACE[host] || DEFAULT_PACE,
    });
  }
  return lanes.get(host);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Take a turn in this host's queue: wait out any cooldown, then hold the
 * minimum gap since the previous request to the same host.
 */
function takeTurn(lane) {
  const turn = lane.chain.then(async () => {
    for (;;) {
      const now = Date.now();
      const earliest = Math.max(lane.lastAt + lane.pace, lane.cooldownUntil);
      if (earliest <= now) break;
      // Sleep in slices so clearCooldown() can release a long wait promptly.
      await sleep(Math.min(400, earliest - now));
    }
    lane.lastAt = Date.now();
  });
  lane.chain = turn.catch(() => {});
  return turn;
}

let googleKey = '';
let quotaUser = '';

/**
 * An optional Google Books API key, entered by you in Settings and kept in
 * this phone's database. It is deliberately NOT in the repo: that repo is
 * public, and a key committed there is a key anyone can spend.
 *
 * With a key you get a project quota (1,000 requests/day by default) instead
 * of sharing an anonymous per-IP allowance with everyone else on your network.
 */
export function setGoogleCredentials({ key = '', user = '' } = {}) {
  googleKey = String(key || '').trim();
  quotaUser = String(user || '').trim();
}

export function hasGoogleKey() { 
  return !!googleKey; 
}

export function gbUrl(query, extra = '', country = 'US') {
  let url = `${GB}?q=${encodeURIComponent(query)}&country=${encodeURIComponent(country)}${extra}`;

  if (googleKey) {
    url += `&key=${encodeURIComponent(googleKey)}`;
    if (quotaUser) {
      url += `&quotaUser=${encodeURIComponent(quotaUser)}`;
    }
  }

  return url;
}

/** Is this host currently in a cooldown we should route around? */
export function hostCoolingDown(hostname) {
  const lane = lanes.get(hostname);
  return !!lane && lane.cooldownUntil > Date.now();
}

export const netStats = { requests: 0, ok: 0, rateLimited: 0, networkErrors: 0, notFound: 0 };

export function resetNetStats() {
  netStats.requests = 0;
  netStats.ok = 0;
  netStats.rateLimited = 0;
  netStats.networkErrors = 0;
  netStats.notFound = 0;
}

/** Longest wait currently imposed on any host — what the UI counts down. */
export function cooldownRemaining() {
  let worst = 0;
  for (const lane of lanes.values()) worst = Math.max(worst, lane.cooldownUntil - Date.now());
  return Math.max(0, worst);
}

/** Which hosts are currently in a cooldown, and for how long. */
export function pacingReport() {
  const out = {};
  for (const lane of lanes.values()) {
    out[lane.host] = {
      waitingMs: Math.max(0, lane.cooldownUntil - Date.now()),
      gapMs: lane.pace,
    };
  }
  return out;
}

export function clearCooldown() {
  for (const lane of lanes.values()) { lane.cooldownUntil = 0; lane.backoff = 2000; }
}

/**
 * Cooldowns outlive a run: hitting Stop and immediately pressing Fetch again
 * used to start over at a two-second backoff and get refused all over again.
 * The caller persists this to IndexedDB between runs.
 */
export function exportCooldowns() {
  const out = {};
  for (const lane of lanes.values()) {
    if (lane.cooldownUntil > Date.now()) out[lane.host] = lane.cooldownUntil;
  }
  return out;
}

export function importCooldowns(saved) {
  for (const [host, until] of Object.entries(saved || {})) {
    if (typeof until !== 'number' || until <= Date.now()) continue;
    const lane = laneFor(`https://${host}/`);
    lane.cooldownUntil = Math.max(lane.cooldownUntil, until);
  }
}

/** A 429 may tell us exactly how long to wait — believe it over our guess. */
function retryAfterMs(res) {
  const raw = res.headers && res.headers.get && res.headers.get('Retry-After');
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_BACKOFF);
  const when = Date.parse(raw);
  if (!Number.isNaN(when)) return Math.max(0, Math.min(when - Date.now(), MAX_BACKOFF));
  return 0;
}

function noteRateLimited(lane, res) {
  netStats.rateLimited++;
  const told = res ? retryAfterMs(res) : 0;
  lane.cooldownUntil = Date.now() + (told || lane.backoff);
  lane.backoff = Math.min(lane.backoff * 2, MAX_BACKOFF);
  // Also permanently slow this host down for the rest of the run: being
  // refused once means our chosen gap was too optimistic for this network.
  lane.pace = Math.min(Math.round(lane.pace * 1.5), 5000);
}

function noteSuccess(lane) {
  netStats.ok++;
  lane.backoff = 2000;
}

/** `ctx`, when given, collects the outcome of this one call for one book. */
function note(ctx, key) {
  if (ctx) ctx[key] = (ctx[key] || 0) + 1;
}

async function getJSON(url, ctx = null) {
  const lane = laneFor(url);
  await takeTurn(lane);
  netStats.requests++;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (ctx) ctx.lastStatus = res.status;
    if (res.status === 429 || res.status === 503 || res.status === 502) {
      noteRateLimited(lane, res);
      note(ctx, 'rateLimited');
      return null;
    }
    if (res.status === 403) {
      // Google's 403 body says WHY: real quota exhaustion, or the geolocation
      // failure above. Treating them the same buried this bug for a while.
      let reason = '';
      try {
        const body = await res.json();
        reason = (body && body.error
          && ((body.error.errors && body.error.errors[0] && body.error.errors[0].reason)
            || body.error.message)) || '';
      } catch (_) { /* body wasn't JSON */ }
      if (ctx) ctx.lastReason = reason;
      if (/rate|quota|limit/i.test(reason)) { noteRateLimited(lane, res); note(ctx, 'rateLimited'); }
      else { netStats.notFound++; note(ctx, 'blocked403'); }
      return null;
    }
    if (!res.ok) { netStats.notFound++; note(ctx, 'notFound'); return null; }
    noteSuccess(lane);
    note(ctx, 'ok');
    return await res.json();
  } catch (_) {
    // Aborted, offline, DNS, CORS — all indistinguishable here, all "not our data".
    netStats.networkErrors++;
    note(ctx, 'networkErrors');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- ISBN helpers ---------- */

export function cleanIsbn(input) {
  return String(input || '').replace(/[^0-9Xx]/g, '').toUpperCase();
}

export function isValidIsbn(input) {
  const s = cleanIsbn(input);
  if (s.length === 10) return isbn10Valid(s);
  if (s.length === 13) return isbn13Valid(s);
  return false;
}

function isbn10Valid(s) {
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    if (!/[0-9]/.test(s[i])) return false;
    sum += (10 - i) * Number(s[i]);
  }
  const check = s[9] === 'X' ? 10 : Number(s[9]);
  if (Number.isNaN(check)) return false;
  return (sum + check) % 11 === 0;
}

function isbn13Valid(s) {
  if (!/^\d{13}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
  return sum % 10 === 0;
}

export function toIsbn13(input) {
  const s = cleanIsbn(input);
  if (s.length === 13) return s;
  if (s.length !== 10) return null;
  const core = '978' + s.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return core + check;
}

function googleCountriesForIsbn(isbn) {
  const s = cleanIsbn(isbn);

  // Turkish ISBN prefixes:
  // 978-975 = older/common Turkish publishing prefix
  // 978-625 = newer Turkish publishing prefix
  const likelyTurkish = /^978(?:975|625)/.test(s);

  return likelyTurkish ? ['TR', 'US'] : ['US', 'TR'];
}

function googleCountriesForIsbn(isbn) {
  const s = cleanIsbn(isbn);
  const likelyTurkish = /^978(?:975|625)/.test(s);
  return likelyTurkish ? ['TR', 'US'] : ['US', 'TR'];
}

/* ---------- genre normalisation ----------
 * Raw subject tags are a swamp ("American fiction, 20th century", "Fiction, fantasy, epic").
 * Map them onto a small, browsable set instead.
 */

/* Order matters: each subject tag is matched against these top to bottom and
 * claimed by the FIRST rule that fits. That is what stops "science fiction"
 * also counting as Science, and "non fiction" counting as Fiction.
 * Patterns tolerate hyphens or spaces, since shelf names use both. */
const GENRE_RULES = [
  ['Science Fiction', /science[-\s]?fiction|\bsci[-\s]?fi\b|space opera|dystopi|cyberpunk|time travel/],
  ['Historical Fiction', /historical[-\s]?fiction|history.*fiction|fiction.*historical/],
  ['Literary Fiction', /literary/],
  ['Nonfiction', /non[-\s]?fiction/],
  ['Fantasy', /\bfantasy|sword and sorcery|\bmagic\b|wizards|dragons|fairy tale/],
  ['Mythology', /mytholog|folklore|legends/],
  ['Horror', /\bhorror\b|ghost stories|vampires|supernatural|occult/],
  ['True Crime', /true[-\s]?crime/],
  ['Mystery', /\bmystery|detective|whodunit|\bcrime\b|\bnoir\b|cozy/],
  ['Thriller', /thriller|suspense|espionage|spy stories/],
  ['Romance', /\bromance\b|love stories|romantic/],
  ['Young Adult', /young[-\s]?adult|\bya\b|teenage|juvenile fiction/],
  ['Middle Grade', /middle[-\s]?grade|juvenile literature/],
  ['Children’s', /children'?s|picture book|nursery/],
  ['Graphic Novel', /graphic[-\s]?novel|comics?\b|manga/],
  ['Poetry', /\bpoetry|\bpoems\b|\bverse\b/],
  ['Drama', /\bdrama\b|\bplays\b|theater|theatre/],
  ['Short Stories', /short[-\s]?stor(y|ies)/],
  ['Classics', /\bclassic/],
  ['Memoir', /memoir|autobiograph|personal narrative/],
  ['Biography', /biograph/],
  ['History', /\bhistory\b|historiography/],
  ['Self-Help', /self[-\s]?help|personal growth|self[-\s]?improvement|motivational|productivity|habits/],
  ['Psychology', /psycholog|mental health|neuroscience/],
  ['Philosophy', /philosoph|ethics|metaphysic/],
  ['Science', /\bscience\b|physics|biology|astronom|mathemat|chemistry|evolution/],
  ['Nature', /\bnature\b|ecology|environment|natural history|wildlife/],
  ['Business', /business|economics|management|entrepreneur|finance/],
  ['Politics', /politic|government|public policy/],
  ['Religion', /religio|theolog|spiritual|christian|buddhis|islam|judaism/],
  ['Travel', /travel|voyages|guidebook/],
  ['Cookbook', /cook(ing|book|ery)|recipes|food writing/],
  ['Art', /\bart\b|painting|photograph|\bdesign\b|architecture/],
  ['Essays', /essays/],
  ['Health', /health|medicine|fitness|nutrition/],
  ['Reference', /reference|dictionar|encyclopedi|handbook/],
  ['Contemporary', /contemporary/],
  ['Fiction', /\bfiction\b|\bnovel\b/],
];

/** Map a pile of raw subject strings onto our curated genre list. */
export function normaliseGenres(rawSubjects, { max = 4 } = {}) {
  const parts = [];
  for (const s of rawSubjects || []) {
    const text = typeof s === 'string' ? s : (s && s.name) || '';
    // Google's "Fiction / Fantasy / Epic" is really three tags; so is
    // Goodreads' "epic-fantasy, favourites".
    text.split(/[/>,]|--/).forEach((p) => {
      const t = p.trim().toLowerCase().replace(/_/g, ' ');
      if (t) parts.push(t);
    });
  }

  const hits = [];
  for (const part of parts) {
    const rule = GENRE_RULES.find(([, re]) => re.test(part));
    if (rule && !hits.includes(rule[0])) hits.push(rule[0]);
  }

  // "Fiction"/"Nonfiction" only earn a slot when nothing sharper matched.
  const specific = hits.filter((g) => g !== 'Fiction' && g !== 'Nonfiction');
  const chosen = specific.length ? specific : hits;
  return chosen.slice(0, max);
}

/* ---------- series parsing ---------- */

/** "The Stormlight Archive #2" / "Discworld, Book 5" / "(Wayfarers, #1)" -> {series, index} */
export function parseSeries(raw) {
  if (!raw) return { series: '', seriesIndex: null };
  let s = String(Array.isArray(raw) ? raw[0] : raw).trim();
  s = s.replace(/^\(|\)$/g, '').trim();
  const m = s.match(/^(.*?)[\s,;:]*(?:#|bk\.?|book|vol\.?|volume|part|no\.?)\s*([0-9]+(?:\.[0-9]+)?)\s*$/i);
  if (m) return { series: tidySeries(m[1]), seriesIndex: Number(m[2]) };
  const m2 = s.match(/^(.*?)[\s,]+([0-9]{1,2})$/);
  if (m2 && m2[1].length > 3) return { series: tidySeries(m2[1]), seriesIndex: Number(m2[2]) };
  return { series: tidySeries(s), seriesIndex: null };
}

function tidySeries(s) {
  return String(s || '').replace(/[\s,;:#-]+$/, '').trim();
}

/** Pull "(Series, #3)" out of a Goodreads/Google Books style title. */
export function parseTitleSeries(title) {
  return seriesFromTitle(title);
}

function seriesFromTitle(title) {
  const m = String(title || '').match(/\(([^()]*(?:#|book|vol)[^()]*)\)\s*$/i);
  if (!m) return null;
  const parsed = parseSeries(m[1]);
  return parsed.series ? { ...parsed, cleanTitle: title.replace(m[0], '').trim() } : null;
}

/* ---------- Open Library ---------- */

async function fromOpenLibrary(isbn, ctx = null) {
  const key = `ISBN:${isbn}`;
  const [data, edition] = await Promise.all([
    getJSON(`${OL}/api/books?bibkeys=${encodeURIComponent(key)}&format=json&jscmd=data`, ctx),
    getJSON(`${OL}/isbn/${isbn}.json`, ctx),
  ]);
  const d = data && data[key];
  if (!d && !edition) return null;

  const subjects = [];
  if (d && d.subjects) subjects.push(...d.subjects.map((s) => s.name || s));
  if (edition && edition.subjects) subjects.push(...edition.subjects);

  // The work record usually has the richest subject list — but it's a third
  // request per book, so only spend it when the edition gave us little.
  let workSubjects = [];
  let description = '';
  const workKey = edition && edition.works && edition.works[0] && edition.works[0].key;
  if (workKey && subjects.length < 3) {
    const work = await getJSON(`${OL}${workKey}.json`, ctx);
    if (work) {
      if (Array.isArray(work.subjects)) workSubjects = work.subjects;
      const desc = work.description;
      description = typeof desc === 'string' ? desc : (desc && desc.value) || '';
    }
  }

  const seriesRaw = (edition && edition.series) || null;
  const { series, seriesIndex } = parseSeries(seriesRaw);

  // Only report a cover Open Library actually claims to have. Inventing the
  // by-ISBN URL here made it win the merge below and shadow Google's real one.
  const coverId = edition && Array.isArray(edition.covers) ? edition.covers[0] : null;
  const coverUrl = coverId
    ? `${OL_COVERS}/b/id/${coverId}-L.jpg`
    : (d && d.cover && (d.cover.large || d.cover.medium)) || '';

  return {
    title: (d && d.title) || (edition && edition.title) || '',
    subtitle: (d && d.subtitle) || (edition && edition.subtitle) || '',
    authors: (d && d.authors ? d.authors.map((a) => a.name) : []).filter(Boolean),
    year: yearOf((d && d.publish_date) || (edition && edition.publish_date)),
    publisher: (d && d.publishers && d.publishers[0] && d.publishers[0].name)
      || (edition && edition.publishers && edition.publishers[0]) || '',
    pageCount: (d && d.number_of_pages) || (edition && edition.number_of_pages) || null,
    series,
    seriesIndex,
    rawSubjects: subjects.concat(workSubjects),
    description,
    coverUrl,
    _source: 'openlibrary',
  };
}

/* ---------- Google Books ---------- */

async function fromGoogleBooks(query, ctx = null) {
  const data = await getJSON(gbUrl(query, '&maxResults=5'), ctx);
  if (!data || !data.items || !data.items.length) return null;
  return volumeToBook(data.items[0]);
}

function volumeToBook(item) {
  const v = item.volumeInfo || {};
  const ids = v.industryIdentifiers || [];
  const find = (t) => {
    const hit = ids.find((i) => i.type === t);
    return hit ? hit.identifier : null;
  };
  let title = v.title || '';
  let series = '';
  let seriesIndex = null;
  const st = seriesFromTitle(title);
  if (st) { series = st.series; seriesIndex = st.seriesIndex; title = st.cleanTitle || title; }

  let coverUrl = '';
  if (v.imageLinks) {
    coverUrl = v.imageLinks.extraLarge || v.imageLinks.large || v.imageLinks.medium
      || v.imageLinks.thumbnail || v.imageLinks.smallThumbnail || '';
    // Google hands back http:// and a tiny zoom level; fix both.
    coverUrl = coverUrl.replace(/^http:/, 'https:').replace(/&zoom=\d/, '&zoom=1').replace(/&edge=curl/, '');
  }

  return {
    title,
    subtitle: v.subtitle || '',
    authors: v.authors || [],
    year: yearOf(v.publishedDate),
    publisher: v.publisher || '',
    pageCount: v.pageCount || null,
    language: v.language || '',
    series,
    seriesIndex,
    rawSubjects: v.categories || [],
    description: v.description || '',
    coverUrl,
    isbn13: find('ISBN_13'),
    isbn10: find('ISBN_10'),
    _source: 'googlebooks',
  };
}

function yearOf(dateish) {
  const m = String(dateish || '').match(/(\d{4})/);
  return m ? Number(m[1]) : null;
}

/* ---------- merge ---------- */

function pick(...vals) {
  for (const v of vals) {
    if (v === 0) continue;
    if (v != null && v !== '' && !(Array.isArray(v) && v.length === 0)) return v;
  }
  return null;
}

async function fromGoogleBooksCountries(query, countries, ctx = null) {
  for (const country of countries) {
    const data = await getJSON(
      gbUrl(query, '&maxResults=5', country),
      ctx
    );

    if (data && data.items && data.items.length) {
      return volumeToBook(data.items[0]);
    }
  }

  return null;
}

/**
 * Look an ISBN up in both sources and merge the results.
 * Returns null only if neither source knows the book.
 */
export async function lookupIsbn(isbnInput, ctx = null) {
  const isbn = cleanIsbn(isbnInput);
  if (!isbn) return null;

  const isbn13 = toIsbn13(isbn) || isbn;

  const [ol, gb] = await Promise.all([
    fromOpenLibrary(isbn, ctx).catch(() => null),
    fromGoogleBooksCountries(
      `isbn:${isbn}`,
      googleCountriesForIsbn(isbn),
      ctx
    ).catch(() => null),
  ]);

  if (!ol && !gb) return null;

  const a = ol || {};
  const b = gb || {};

  const rawSubjects = [
    ...(b.rawSubjects || []),
    ...(a.rawSubjects || [])
  ];

  return {
    isbn13,
    isbn10: pick(
      b.isbn10,
      a.isbn10,
      isbn.length === 10 ? isbn : null
    ),
    title: pick(a.title, b.title) || 'Untitled',
    subtitle: pick(b.subtitle, a.subtitle) || '',
    authors: pick(a.authors, b.authors) || [],
    year: pick(a.year, b.year),
    publisher: pick(a.publisher, b.publisher) || '',
    pageCount: pick(a.pageCount, b.pageCount),
    language: pick(b.language, a.language) || '',
    series: pick(a.series, b.series) || '',
    seriesIndex: pick(a.seriesIndex, b.seriesIndex),
    genres: normaliseGenres(rawSubjects),
    rawSubjects: rawSubjects.slice(0, 30),
    description: pick(b.description, a.description) || '',
    coverUrl: pick(a.coverUrl, b.coverUrl) || '',
    source: [ol && 'openlibrary', gb && 'googlebooks']
      .filter(Boolean)
      .join('+'),
  };
}

/** Free-text search, for books with no barcode (old paperbacks, gifts, ebooks). */
export async function searchBooks(query, { limit = 20, sources = ['google', 'openlibrary'] } = {}, ctx = null) {
  const q = String(query || '').trim();
  if (!q) return [];
  const [gb, ol] = await Promise.all([
    sources.includes('google')
      ? getJSON(gbUrl(q, `&maxResults=${limit}`), ctx)
      : null,
    sources.includes('openlibrary')
      ? getJSON(`${OL}/search.json?q=${encodeURIComponent(q)}&limit=${limit}&fields=key,title,author_name,first_publish_year,isbn,cover_i,subject`, ctx)
      : null,
  ]);

  const out = [];
  const seen = new Set();

  if (gb && gb.items) {
    for (const item of gb.items) {
      const bk = volumeToBook(item);
      const key = (bk.title + '|' + (bk.authors[0] || '')).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ...bk,
        genres: normaliseGenres(bk.rawSubjects),
        isbn13: bk.isbn13 || (bk.isbn10 ? toIsbn13(bk.isbn10) : null),
        source: 'googlebooks',
      });
    }
  }

  if (ol && ol.docs) {
    for (const doc of ol.docs) {
      const key = (doc.title + '|' + ((doc.author_name || [])[0] || '')).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const isbn = (doc.isbn || [])[0] || null;
      out.push({
        title: doc.title || 'Untitled',
        subtitle: '',
        authors: doc.author_name || [],
        year: doc.first_publish_year || null,
        publisher: '',
        pageCount: null,
        series: '',
        seriesIndex: null,
        genres: normaliseGenres(doc.subject || []),
        rawSubjects: (doc.subject || []).slice(0, 20),
        description: '',
        coverUrl: doc.cover_i ? `${OL_COVERS}/b/id/${doc.cover_i}-L.jpg` : (isbn ? `${OL_COVERS}/b/isbn/${isbn}-L.jpg` : ''),
        isbn13: isbn && isbn.length === 13 ? isbn : (isbn ? toIsbn13(isbn) : null),
        isbn10: isbn && isbn.length === 10 ? isbn : null,
        source: 'openlibrary',
      });
    }
  }

  return out.slice(0, limit);
}

/**
 * Download a cover so it still shows on the subway.
 * Returns a Blob, or null if the host refuses cross-origin reads —
 * in that case we fall back to displaying the remote URL directly.
 */
export async function fetchCoverBlob(url, ctx = null) {
  if (!url) return null;
  // Without a timeout a stalled image host hangs the caller forever — which is
  // exactly how a bulk fetch ends up frozen with the progress bar still moving.
  const lane = laneFor(url);
  await takeTurn(lane);
  netStats.requests++;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { mode: 'cors', signal: ctrl.signal });
    if (res.status === 429 || res.status === 503) {
      noteRateLimited(lane, res); note(ctx, 'rateLimited'); return null;
    }
    if (!res.ok) { netStats.notFound++; note(ctx, 'notFound'); return null; }
    noteSuccess(lane);
    note(ctx, 'ok');
    const blob = await res.blob();
    // Open Library serves a 1x1 pixel when it has no cover on file.
    if (blob.size < 1024) return null;
    if (!/^image\//.test(blob.type)) return null;
    return blob;
  } catch (_) {
    netStats.networkErrors++;
    note(ctx, 'networkErrors');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Open Library will serve a cover straight off an ISBN — no metadata call needed.
 * `default=false` makes it 404 when it has nothing, instead of handing back a
 * blank placeholder image that looks like success.
 */
export function coverUrlForIsbn(isbn) {
  const clean = cleanIsbn(isbn);
  return clean ? `${OL_COVERS}/b/isbn/${clean}-L.jpg?default=false` : '';
}

/**
 * Check that an image URL actually renders.
 *
 * Needed because Google's cover images send no CORS headers, so `fetch` can't
 * read them — but an <img> tag can display them perfectly well. This is the only
 * way to tell "Google has a cover for this" from "that URL is a dead end".
 */
export function verifyImageUrl(url, timeoutMs = 8000, { noReferrer = false } = {}) {
  return new Promise((resolve) => {
    if (!url) { resolve(false); return; }
    const img = new Image();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    // A 1x1 tracking pixel or a "no image" sliver is not a cover.
    img.onload = () => finish(img.naturalWidth > 50 && img.naturalHeight > 50);
    img.onerror = () => finish(false);
    // Some Google image endpoints 403 a request with no referrer, so only
    // strip it on a deliberate second attempt.
    if (noReferrer) img.referrerPolicy = 'no-referrer';
    img.src = url;
  });
}

/** Bigger variants of a Google Books thumbnail, best first. */
function googleCoverVariants(url) {
  if (!url) return [];
  const base = url.replace(/^http:/, 'https:').replace(/&edge=curl/, '');
  const out = [];
  if (/zoom=\d/.test(base)) {
    // Biggest first, then down. Not every volume offers every level.
    for (const z of [3, 2, 1, 0]) out.push(base.replace(/zoom=\d/, 'zoom=' + z));
  } else {
    out.push(base);
  }
  return [...new Set(out)];
}

/**
 * Find a cover by any means available, cheapest first.
 *
 * Returns { blob, url } — `blob` when we managed to download it (works offline
 * afterwards), otherwise just `url` for a cover we've confirmed renders but
 * can't copy because the host blocks cross-origin reads. Null if nothing worked.
 */
export async function findCover(book, found = null, ctx = null) {
  const isbns = [...new Set(
    [book.isbn13, book.isbn10, found && found.isbn13, found && found.isbn10].filter(Boolean)
  )];

  /* Try to download it, and if that fails, settle for one that merely
   * displays. Hosts that block cross-origin reads — Google always, and
   * Open Library's CDN sometimes — still render perfectly well in an <img>. */
  const tryUrl = async (url) => {
    if (!url) return null;
    const blob = await fetchCoverBlob(url, ctx);
    if (blob) return { blob, url };
    for (const variant of googleCoverVariants(url)) {
      if (await verifyImageUrl(variant)) return { blob: null, url: variant };
      if (await verifyImageUrl(variant, 8000, { noReferrer: true })) {
        return { blob: null, url: variant };
      }
    }
    return null;
  };

  // 1. Open Library, straight off the ISBN. One request, no JSON.
  for (const isbn of isbns) {
    const hit = await tryUrl(coverUrlForIsbn(isbn));
    if (hit) return hit;
  }

  // 2. Whatever the metadata lookup already turned up.
  if (found && found.coverUrl) {
    const hit = await tryUrl(found.coverUrl);
    if (hit) return hit;
  }

  // 3. Other editions of the same book. Google only at this stage: it has
  //    artwork for almost everything and is far more tolerant of bulk use than
  //    Open Library's search endpoint, which is the first thing to throttle.
  const query = [book.title, (book.authors || [])[0]].filter(Boolean).join(' ');
  if (!query) return null;

  const order = hostCoolingDown('www.googleapis.com')
    ? [['openlibrary'], ['google']]   // Google is in a cooldown — don't queue behind it
    : [['google'], ['openlibrary']];
  for (const sources of order) {
    const hits = await searchBooks(query, { limit: 5, sources }, ctx);
    for (const candidate of hits) {
      if (!plausibleMatch(book, candidate) || !candidate.coverUrl) continue;
      const hit = await tryUrl(candidate.coverUrl);
      if (hit) return hit;
    }
    // Only spend an Open Library search if Google genuinely had nothing.
    if (hits.length && hits.some((c) => plausibleMatch(book, c))) break;
  }

  return null;
}

/**
 * One request to each service, to tell "these books have no covers" apart from
 * "we are being throttled" or "this phone has no working connection".
 */
export async function probeServices() {
  const isbn = '9780765326355';           // The Way of Kings — everyone has this
  const before = { ...netStats };
  const probeCtx = {};
  const result = {};

  const olCtx = {};
  const olJson = await getJSON(`${OL}/isbn/${isbn}.json`, olCtx);
  result.openLibraryData = olJson ? 'ok'
    : `failed${olCtx.lastStatus ? ' (HTTP ' + olCtx.lastStatus + ')' : ' (no response)'}`;

  const cover = await fetchCoverBlob(coverUrlForIsbn(isbn));
  result.openLibraryCoverDownload = cover ? 'ok' : 'failed';
  if (!cover) {
    result.openLibraryCoverDisplay =
      await verifyImageUrl(coverUrlForIsbn(isbn)) ? 'ok' : 'failed';
  }

  const gb = await getJSON(gbUrl(`isbn:${isbn}`), probeCtx);
  if (gb && gb.items && gb.items.length) {
    result.googleBooksData = 'ok';
  } else if (probeCtx.lastStatus === 403 && !/rate|quota/i.test(probeCtx.lastReason || '')) {
    result.googleBooksData = 'failed (HTTP 403 — Google cannot place this network; '
      + 'the app now sends country=US to work around it, so this line should read ok '
      + 'after updating)';
  } else if (probeCtx.lastStatus) {
    result.googleBooksData = `failed (HTTP ${probeCtx.lastStatus}`
      + (probeCtx.lastReason ? ': ' + probeCtx.lastReason : '') + ')';
  } else {
    result.googleBooksData = 'failed (no response)';
  }

  const thumb = gb && gb.items && gb.items[0] && gb.items[0].volumeInfo
    && gb.items[0].volumeInfo.imageLinks
    && gb.items[0].volumeInfo.imageLinks.thumbnail;
  result.googleCoverDisplay = thumb
    ? (await verifyImageUrl(googleCoverVariants(thumb)[0]) ? 'ok' : 'failed')
    : 'no image offered';

  result.throttledDuringProbe = netStats.rateLimited - before.rateLimited;
  result.networkErrorsDuringProbe = netStats.networkErrors - before.networkErrors;
  return result;
}

/**
 * Is this lookup result actually the same book?
 * Title-based fallback searches can return something plausible but wrong, and
 * attaching the wrong cover is worse than attaching none.
 */
export function plausibleMatch(book, found) {
  if (!found) return false;
  const norm = (s) => String(s || '')
  .toLocaleLowerCase('tr-TR')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9çğıöşü ]/gi, ' ')
  .replace(/\s+/g, ' ')
  .trim();

  const a = norm(book.title);
  const b = norm(found.title);
  if (!a || !b) return false;
  if (a === b || a.startsWith(b) || b.startsWith(a)) return true;

  // Otherwise demand a shared author as well as decent title overlap.
  const authorsA = (book.authors || []).map(norm);
  const authorsB = (found.authors || []).map(norm);
  const sharedAuthor = authorsA.some((x) => authorsB.some((y) => x && (x === y || y.includes(x) || x.includes(y))));
  if (!sharedAuthor) return false;

  const wordsA = new Set(a.split(' ').filter((w) => w.length > 3));
  const wordsB = new Set(b.split(' ').filter((w) => w.length > 3));
  if (!wordsA.size) return false;
  let shared = 0;
  for (const w of wordsA) if (wordsB.has(w)) shared++;
  return shared / wordsA.size >= 0.6;
}
