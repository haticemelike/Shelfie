/* End-to-end smoke test. Runs the real app in Chromium with the book APIs mocked,
 * since this build box has no route to openlibrary.org. */

import { chromium } from 'playwright';
import { serve } from './serve.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'http://localhost:8099';
const SHOTS = path.join(DIR, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const failures = [];
const passes = [];

function check(name, ok, detail = '') {
  if (ok) { passes.push(name); console.log('  ok  ' + name); }
  else { failures.push(name + (detail ? ' — ' + detail : '')); console.log('FAIL  ' + name + (detail ? ' — ' + detail : '')); }
}

/* A plausible 400x600 cover stands in for a real download. It must be over 1KB —
 * the app treats tiny responses as Open Library's "no cover on file" placeholder. */
const COVER_PNG = fs.readFileSync(path.join(DIR, 'fixture-cover.png'));

const OL_DATA = (isbn) => ({
  [`ISBN:${isbn}`]: {
    title: 'The Way of Kings',
    subtitle: '',
    authors: [{ name: 'Brandon Sanderson' }],
    number_of_pages: 1007,
    publishers: [{ name: 'Tor Books' }],
    publish_date: 'August 31, 2010',
    subjects: [{ name: 'Epic fantasy' }, { name: 'Fiction, fantasy, epic' }],
    cover: { large: 'https://covers.openlibrary.org/b/id/111-L.jpg' },
  },
});

const OL_EDITION = {
  title: 'The Way of Kings',
  series: ['The Stormlight Archive #1'],
  number_of_pages: 1007,
  covers: [111],
  publish_date: '2010',
  publishers: ['Tor Books'],
  works: [{ key: '/works/OL1W' }],
  subjects: ['Fantasy fiction'],
};

const OL_WORK = { subjects: ['Fantasy', 'Epic fantasy'], description: { value: 'Roshar is a world of stone and storms.' } };

const GB_VOLUMES = {
  items: [{
    volumeInfo: {
      title: 'The Way of Kings',
      authors: ['Brandon Sanderson'],
      publishedDate: '2010-08-31',
      publisher: 'Tor Books',
      pageCount: 1007,
      categories: ['Fiction / Fantasy / Epic'],
      language: 'en',
      description: 'The first volume of the Stormlight Archive.',
      industryIdentifiers: [
        { type: 'ISBN_13', identifier: '9780765326355' },
        { type: 'ISBN_10', identifier: '0765326353' },
      ],
      imageLinks: { thumbnail: 'http://books.google.com/books/content?id=abc&zoom=1' },
    },
  }],
};

const GB_SEARCH = {
  items: [
    {
      volumeInfo: {
        title: 'Piranesi',
        authors: ['Susanna Clarke'],
        publishedDate: '2020',
        pageCount: 245,
        categories: ['Fiction / Fantasy / General'],
        industryIdentifiers: [{ type: 'ISBN_13', identifier: '9781635575637' }],
        imageLinks: { thumbnail: 'http://books.google.com/books/content?id=xyz&zoom=1' },
      },
    },
  ],
};

async function main() {
  const server = await serve(8099);
  // This box ships its own Chromium build; point Playwright straight at it.
  const local = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch(fs.existsSync(local) ? { executablePath: local } : {});
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
  });

  await ctx.route('**/openlibrary.org/api/books*', (route) => {
    const isbn = new URL(route.request().url()).searchParams.get('bibkeys').replace('ISBN:', '');
    route.fulfill({ json: OL_DATA(isbn) });
  });
  await ctx.route('**/openlibrary.org/isbn/*', (route) => route.fulfill({ json: OL_EDITION }));
  await ctx.route('**/openlibrary.org/works/*', (route) => route.fulfill({ json: OL_WORK }));
  await ctx.route('**/openlibrary.org/search.json*', (route) => route.fulfill({ json: { docs: [] } }));
  // Note the missing slash before the host: the real URL is www.googleapis.com,
  // so "**/googleapis.com" would never match and the mock would silently miss.
  await ctx.route('**googleapis.com/books/v1/volumes*', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') || '';
    route.fulfill({ json: q.startsWith('isbn:') ? GB_VOLUMES : GB_SEARCH });
  });
  await ctx.route('**/covers.openlibrary.org/**', (route) =>
    route.fulfill({ body: COVER_PNG, contentType: 'image/png' }));
  await ctx.route('**/books.google.com/**', (route) =>
    route.fulfill({ body: COVER_PNG, contentType: 'image/png' }));

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message + '\n' + (e.stack||'')));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  page.on('requestfailed', (r) => errors.push('requestfailed: ' + r.url() + ' — ' + (r.failure()?.errorText || '')));

  console.log('\n— boot —');
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.tabbar .tab');
  check('app boots without script errors', errors.length === 0, errors.join(' | '));
  check('four tabs render', (await page.locator('.tab').count()) === 4);
  check('empty state shown', await page.locator('.empty').isVisible());
  await page.screenshot({ path: path.join(SHOTS, '01-empty.png') });

  console.log('\n— goodreads import —');
  await page.click('.tab[data-tab="settings"]');
  await page.waitForSelector('#gr-file');
  await page.setInputFiles('#gr-file', path.join(DIR, 'goodreads-sample.csv'));
  await page.waitForSelector('.sheet');
  const summary = await page.locator('.sheet__body').innerText();
  check('import sheet reports 16 books', /16 book/.test(summary), summary.replace(/\n/g, ' / '));
  await page.screenshot({ path: path.join(SHOTS, '02-import.png') });
  await page.click('.sheet__foot .btn--primary');
  await page.waitForTimeout(600);

  console.log('\n— library —');
  await page.click('.tab[data-tab="library"]');
  await page.waitForSelector('.shelf');
  const shelfCount = await page.locator('.sbook').count();
  check('all 16 books on the shelves', shelfCount === 16, 'saw ' + shelfCount);

  const groups = await page.locator('.group__title').allInnerTexts();
  check('grouped by series with real series names',
    groups.includes('The Stormlight Archive'), groups.join(', '));
  check('standalone books get their own group', groups.includes('Standalone'), groups.join(', '));
  const groupCount = await page.locator('.group__count').first().innerText();
  check('each group header carries a count', /\d/.test(groupCount), groupCount);
  const stormlight = await page.locator('.group:has-text("The Stormlight Archive") .group__count').first().innerText();
  check('the count matches the books under it', stormlight.startsWith('2'), stormlight);
  await page.screenshot({ path: path.join(SHOTS, '03-shelf-series.png'), fullPage: true });

  console.log('\n— grouping and view toggle —');
  await page.click('.seg__btn:has-text("Author")');
  await page.waitForTimeout(150);
  const authorGroups = await page.locator('.group__title').allInnerTexts();
  check('author grouping sorts by surname',
    authorGroups.indexOf('Suzanne Collins') < authorGroups.indexOf('J.R.R. Tolkien'),
    authorGroups.join(', '));

  await page.click('.seg__btn:has-text("Genre")');
  await page.waitForTimeout(150);
  const genreGroups = await page.locator('.group__title').allInnerTexts();
  check('shelves become genres', genreGroups.some((g) => /Fantasy|Classics|Science Fiction/.test(g)),
    genreGroups.join(', '));
  await page.screenshot({ path: path.join(SHOTS, '04-shelf-genre.png'), fullPage: true });

  await page.click('.icon-btn--bordered');
  await page.waitForSelector('.grid');
  check('grid view renders', (await page.locator('.gbook').count()) > 0);
  await page.screenshot({ path: path.join(SHOTS, '05-grid.png'), fullPage: true });
  await page.click('.icon-btn--bordered'); // back to shelf
  await page.waitForSelector('.shelf');

  console.log('\n— bulk fetch of covers & genres —');
  await page.click('.tab[data-tab="settings"]');
  await page.waitForSelector('#enrich-btn');
  const enrichLabel = await page.locator('#enrich-btn').innerText();
  check('offers to fetch for the books missing artwork', /Fetch for \d+ book/.test(enrichLabel), enrichLabel);

  const t0 = Date.now();
  await page.click('#enrich-btn');
  await page.waitForFunction(
    () => /^Done\.|Nothing is coming back/.test(document.getElementById('enrich-status')?.textContent || ''),
    null, { timeout: 60000 });
  const elapsed = Date.now() - t0;
  const enrichStatus = await page.locator('#enrich-status').innerText();
  check('bulk fetch finishes and reports what it did', /^Done\./.test(enrichStatus), enrichStatus);
  check('it actually updated books rather than just moving the bar',
    /(\d+) updated/.test(enrichStatus) && Number(enrichStatus.match(/(\d+) updated/)[1]) > 0, enrichStatus);
  // Serial + 320ms/book would put 16 books well over 20s; the pool should be far quicker.
  check('runs concurrently, not one book at a time', elapsed < 20000, elapsed + 'ms for 16 books');
  await page.screenshot({ path: path.join(SHOTS, '10-enrich.png') });

  await page.click('.tab[data-tab="library"]');
  await page.waitForSelector('.shelf');
  const withCovers = await page.locator('.sbook img.cover').count();
  check('covers are now showing on the shelves', withCovers > 10, 'saw ' + withCovers);

  console.log('\n— a multi-genre book appears under each of its genres —');
  await page.click('.seg__btn:has-text("Genre")');
  await page.waitForTimeout(150);
  const gatsbyTiles = await page.locator('.sbook[aria-label*="Great Gatsby"]').count();
  check('The Great Gatsby is filed under both Classics and Literary Fiction',
    gatsbyTiles === 2, 'saw ' + gatsbyTiles);

  console.log('\n— search and filters —');
  // Flat listing, so each book is counted exactly once.
  await page.click('.seg__btn:has-text("All books")');
  await page.waitForTimeout(150);
  await page.fill('#lib-search', 'sanderson');
  await page.waitForTimeout(300);
  check('author search finds both Sanderson books', (await page.locator('.sbook').count()) === 2,
    'saw ' + await page.locator('.sbook').count());

  await page.fill('#lib-search', 'piranesi');
  await page.waitForTimeout(300);
  check('title search finds one book', (await page.locator('.sbook').count()) === 1);

  await page.fill('#lib-search', '');
  await page.waitForTimeout(300);
  await page.click('.chip:has-text("TBR")');
  await page.waitForTimeout(200);
  const tbr = await page.locator('.sbook').count();
  check('TBR filter shows the 2 to-read books', tbr === 2, 'saw ' + tbr);

  await page.click('.chip:has-text("DNF")');
  await page.waitForTimeout(200);
  const dnf = await page.locator('.sbook').count();
  check('DNF shelf picked up from a Goodreads shelf name', dnf === 1, 'saw ' + dnf);

  await page.click('.chip:text-is("All")');
  await page.waitForTimeout(200);

  console.log('\n— ownership —');
  const faded = await page.locator('.sbook.is-unowned').count();
  check('books not owned render faded', faded === 5, 'saw ' + faded);
  await page.click('.chip--owned');   // any -> owned
  await page.waitForTimeout(200);
  const ownedOnly = await page.locator('.sbook').count();
  check('“On my shelf” filter shows only owned books', ownedOnly === 11, 'saw ' + ownedOnly);
  check('nothing faded remains when filtered to owned',
    (await page.locator('.sbook.is-unowned').count()) === 0);

  await page.click('.chip--owned');   // owned -> unowned
  await page.waitForTimeout(200);
  const unownedOnly = await page.locator('.sbook').count();
  check('“Don’t own” filter shows only the rest', unownedOnly === 5, 'saw ' + unownedOnly);

  // Ownership must AND with status, not replace it.
  await page.click('.chip:text-is("Read")');
  await page.waitForTimeout(200);
  const unownedRead = await page.locator('.sbook').count();
  check('ownership filter combines with the status filter', unownedRead === 2, 'saw ' + unownedRead);

  await page.click('.chip--owned');   // back to any
  await page.click('.chip:text-is("All")');
  await page.waitForTimeout(200);

  console.log('\n— book detail, rereads, rating, review —');
  await page.fill('#lib-search', 'hobbit');
  await page.waitForTimeout(300);
  await page.click('.sbook');
  await page.waitForSelector('.book__title');
  check('detail shows the right book', (await page.locator('.book__title').innerText()) === 'The Hobbit');
  const rereadBadge = await page.locator('.badge--reread').count();
  check('reread count of 5 survives the import', rereadBadge === 1);
  const sessions = await page.locator('.session').count();
  check('five reading sessions logged', sessions === 5, 'saw ' + sessions);
  await page.screenshot({ path: path.join(SHOTS, '06-book.png'), fullPage: true });

  // Rate it 4.5 by tapping the left half of the fifth star.
  const fifth = page.locator('.star-hit').nth(4);
  const box = await fifth.boundingBox();
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height / 2);
  await page.waitForTimeout(300);
  const ratingText = await page.locator('.card__rowhead .muted').first().innerText();
  check('half-star rating records 4.5', ratingText.includes('4.5'), ratingText);

  // Add a fresh reread.
  await page.click('button:has-text("Read it again")');
  await page.waitForTimeout(400);
  const after = await page.locator('.session').count();
  check('“Read it again” appends a session, keeps the old ones', after === 6, 'saw ' + after);
  const statusOn = await page.locator('.seg--wide .seg__btn.is-on').first().innerText();
  check('status flips to Reading after a reread starts', statusOn === 'Reading', statusOn);

  // Write a review.
  await page.fill('.input--area', 'Still the best comfort read there is.');
  await page.click('.book__title');
  await page.waitForTimeout(400);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.input--area');
  const persistedReview = await page.locator('.input--area').inputValue();
  check('review survives a reload', persistedReview.includes('comfort read'), persistedReview);

  console.log('\n— ownership toggle on the book page —');
  const ownOn = await page.locator('.ownrow .seg__btn.is-on').innerText();
  check('imported owned book shows as on the shelf', /On my shelf/.test(ownOn), ownOn);
  await page.click('.ownrow .seg__btn:has-text("Don’t own it")');
  await page.waitForTimeout(300);
  const ownOn2 = await page.locator('.ownrow .seg__btn.is-on').innerText();
  check('toggling ownership sticks', /Don’t own/.test(ownOn2), ownOn2);
  await page.click('.ownrow .seg__btn:has-text("Don’t own it")');  // tap again to clear
  await page.waitForTimeout(300);
  check('tapping the active choice clears it back to unset',
    (await page.locator('.ownrow .seg__btn.is-on').count()) === 0);
  await page.click('.ownrow .seg__btn:has-text("On my shelf")');
  await page.waitForTimeout(300);

  console.log('\n— a date inferred from Date Added —');
  await page.click('.tab[data-tab="library"]');
  await page.waitForSelector('.shelf');
  await page.fill('#lib-search', 'gatsby');
  await page.waitForTimeout(300);
  await page.click('.sbook');
  await page.waitForSelector('.sessions');
  const gatsbySession = await page.locator('.session__label').first().innerText();
  check('an inferred finish date is shown, marked with ≈',
    /^≈ Finished Mar 1, 2011/.test(gatsbySession), gatsbySession);
  const gatsbyNote = await page.locator('.session__sub').first().innerText();
  check('and says where the date came from', /added it to Goodreads/.test(gatsbyNote), gatsbyNote);

  await page.click('.session__main');
  await page.waitForSelector('.sheet');
  await page.click('.sheet__foot .btn--primary');
  await page.waitForTimeout(400);
  const afterConfirm = await page.locator('.session__label').first().innerText();
  check('confirming the date clears the ≈', !/≈/.test(afterConfirm), afterConfirm);

  await page.click('.linkish');
  await page.waitForSelector('.shelf');
  await page.fill('#lib-search', 'hobbit');
  await page.waitForTimeout(300);
  await page.click('.sbook');
  await page.waitForSelector('.book__title');

  console.log('\n— manual dates —');
  await page.click('button:has-text("Add dates")');
  await page.waitForSelector('.sheet');
  await page.fill('.sheet input[type="date"] >> nth=0', '2020-01-05');
  await page.fill('.sheet input[type="date"] >> nth=1', '2020-02-10');
  await page.click('.sheet__foot .btn--primary');
  await page.waitForTimeout(400);
  const withManual = await page.locator('.session').count();
  check('manually added dates appear', withManual === 7, 'saw ' + withManual);
  const rangeShown = await page.locator('.session__sub').first().innerText().catch(() => '');
  check('a start→finish range is displayed', /→/.test(await page.locator('.sessions').innerText()), rangeShown);

  console.log('\n— add by ISBN —');
  await page.click('.tab[data-tab="add"]');
  await page.waitForSelector('.scan');
  await page.fill('.inline-form .input', '9780765326355');
  await page.click('.inline-form .btn');
  await page.waitForTimeout(900);
  const dupToast = await page.locator('#toast').innerText().catch(() => '');
  check('re-adding an owned ISBN is caught as a duplicate', /already/i.test(dupToast), dupToast);

  await page.fill('.inline-form .input', '9780306406157'); // valid ISBN, not in library
  await page.click('.inline-form .btn');
  await page.waitForSelector('.sheet', { timeout: 5000 });
  const reviewTitle = await page.locator('.review__fields .input').first().inputValue();
  check('lookup fills in the title', reviewTitle === 'The Way of Kings', reviewTitle);
  const seriesVal = await page.locator('.sheet .form .input').nth(0).inputValue();
  check('series parsed out of "The Stormlight Archive #1"', seriesVal === 'The Stormlight Archive', seriesVal);
  const genreVal = await page.locator('.sheet .form .input').nth(2).inputValue();
  check('messy subjects collapse to a real genre', /Fantasy/.test(genreVal), genreVal);
  await page.screenshot({ path: path.join(SHOTS, '07-add.png') });
  await page.click('.sheet__foot .btn--primary');
  await page.waitForTimeout(900);
  check('added book shows in the just-added log', (await page.locator('#add-log .gbook').count()) === 1);
  check('a book added by ISBN defaults to owned — you were holding it',
    (await page.locator('#add-log .gbook.is-unowned').count()) === 0);

  console.log('\n— search by title (no barcode) —');
  await page.fill('.card:has-text("No barcode") .input', 'piranesi clarke');
  await page.waitForSelector('.result', { timeout: 5000 });
  const firstResult = await page.locator('.result__title').first().innerText();
  check('title search returns Google Books hits', firstResult === 'Piranesi', firstResult);
  await page.click('.result');
  await page.waitForSelector('.sheet');
  const searchAddTitle = await page.locator('.review__fields .input').first().inputValue();
  check('tapping a search result prefills the add form', searchAddTitle === 'Piranesi', searchAddTitle);
  await page.click('.sheet__foot .btn:has-text("Skip")');
  await page.waitForTimeout(300);

  console.log('\n— bad ISBN is rejected —');
  await page.fill('.inline-form .input', '1234567890123');
  await page.click('.inline-form .btn');
  await page.waitForTimeout(400);
  const badToast = await page.locator('#toast').innerText();
  check('checksum rejects a made-up ISBN', /not a valid/i.test(badToast), badToast);

  console.log('\n— stats —');
  await page.click('.tab[data-tab="stats"]');
  await page.waitForSelector('.tiles');
  const tiles = await page.locator('.tile__value').allInnerTexts();
  check('total book count is right', tiles[0] === '17', tiles.join(' / '));
  check('year chart renders', (await page.locator('.bars__row').count()) > 0);
  await page.screenshot({ path: path.join(SHOTS, '08-stats.png'), fullPage: true });

  console.log('\n— re-importing backfills books imported by an older version —');
  {
    // Simulate a library imported before the date inference existed: strip the
    // dates off one book, exactly as the old importer would have left it.
    const target = await page.evaluate(async () => {
      const db = await import('./js/db.js');
      const all = await db.allBooks();
      const b = all.find((x) => x.title === 'Nineteen Eighty-Four');
      b.sessions = b.sessions.map((s) => ({ ...s, finish: null, start: null, dnfAt: null }));
      b.owned = null;
      b.genres = [];
      await db.putBook(b);
      return b.id;
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.click('.tab[data-tab="settings"]');
    await page.setInputFiles('#gr-file', path.join(DIR, 'goodreads-sample.csv'));
    await page.waitForSelector('.sheet');
    const reimport = await page.locator('.sheet__body').innerText();
    check('re-import offers to fill in the gaps it can',
      /could be filled in/.test(reimport), reimport.replace(/\n/g, ' / '));
    check('and explains it will not overwrite your edits',
      /never overwritten/.test(reimport));

    await page.click('.sheet__foot .btn--primary');
    await page.waitForTimeout(700);

    const after = await page.evaluate(async (id) => {
      const db = await import('./js/db.js');
      const b = (await db.allBooks()).find((x) => x.id === id);
      return { finish: b.sessions.find((s) => s.finish)?.finish, owned: b.owned, genres: b.genres.length };
    }, target);
    check('the missing date came back', after.finish === '2013-09-09', JSON.stringify(after));
    check('ownership came back too', after.owned === true, JSON.stringify(after));
    check('genres came back too', after.genres > 0, JSON.stringify(after));

    const total = await page.evaluate(async () => (await (await import('./js/db.js')).allBooks()).length);
    check('re-importing created no duplicates', total === 17, 'saw ' + total);
  }

  console.log('\n— the service probe reports what is actually wrong —');
  await page.click('.tab[data-tab="settings"]');
  await page.waitForSelector('#probe-btn');
  await page.click('#probe-btn');
  await page.waitForFunction(
    () => /Open Library/.test(document.getElementById('probe-out')?.textContent || ''),
    null, { timeout: 30000 });
  const probeText = await page.locator('#probe-out').innerText();
  check('probe reports each service separately',
    /Open Library/.test(probeText) && /Google Books/.test(probeText), probeText.replace(/\n/g, ' / '));
  check('with everything mocked healthy, it says so',
    /Everything is answering/.test(probeText), probeText.replace(/\n/g, ' / '));

  console.log('\n— version is visible —');
  await page.click('.tab[data-tab="settings"]');
  await page.waitForSelector('.version');
  const versionText = await page.locator('.version').innerText();
  check('settings shows the running version', /Version \d/.test(versionText), versionText);
  check('there is an update button', await page.locator('#update-btn').isVisible());

  console.log('\n— backup round trip —');
  const backup = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const payload = await db.exportBackup();
    return { count: payload.count, covers: Object.keys(payload.covers).length, first: payload.books[0].title };
  });
  check('backup contains every book', backup.count === 17, JSON.stringify(backup));
  check('backup carries cover images', backup.covers > 0, 'covers: ' + backup.covers);

  const restored = await page.evaluate(async () => {
    const db = await import('./js/db.js');
    const payload = await db.exportBackup();
    await db.importBackup(payload, { merge: false });
    return (await db.allBooks()).length;
  });
  check('wipe-and-restore returns the same library', restored === 17, 'saw ' + restored);

  // Catches things individual assertions miss — e.g. a view poking another
  // view that isn't on screen after iOS restores the app on a book page.
  const thrown = errors.filter((e) => e.startsWith('pageerror'));
  check('no uncaught errors anywhere in the whole run', thrown.length === 0,
    thrown.join(' | ').slice(0, 300));

  console.log('\n— rate limiting is reported honestly, not as "no covers exist" —');
  {
    const rl = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    });
    // Every service answers 429. The run must say so, and must NOT claim the
    // books have no matches online.
    await rl.route('**/openlibrary.org/**', (r) => r.fulfill({ status: 429, body: '' }));
    await rl.route('**/covers.openlibrary.org/**', (r) => r.fulfill({ status: 429, body: '' }));
    await rl.route('**googleapis.com/**', (r) => r.fulfill({ status: 429, body: '' }));

    const p3 = await rl.newPage();
    await p3.goto(BASE + '/', { waitUntil: 'networkidle' });
    await p3.click('.tab[data-tab="settings"]');
    await p3.setInputFiles('#gr-file', path.join(DIR, 'goodreads-sample.csv'));
    await p3.waitForSelector('.sheet');
    await p3.click('.sheet__foot .btn--primary');
    await p3.waitForTimeout(600);
    await p3.click('#enrich-btn');
    await p3.waitForFunction(
      () => /rate limiting|offline|Every request failed|^Done\./
        .test(document.getElementById('enrich-status')?.textContent || ''),
      null, { timeout: 60000 });
    const rlStatus = await p3.locator('#enrich-status').innerText();
    check('a 429 storm is named as rate limiting', /rate limiting/.test(rlStatus), rlStatus);
    check('and does not blame the books', !/no match/.test(rlStatus), rlStatus);
    await rl.close();
  }

  console.log('\n— cover fallback when Open Library has nothing —');
  {
    // Open Library 404s every cover; only Google has artwork. This used to
    // leave the book blank, because the fast path gave up instead of falling
    // through, and OL's invented URL beat Google's real one in the merge.
    const fb = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    });
    await fb.route('**/covers.openlibrary.org/**', (r) => r.fulfill({ status: 404, body: '' }));
    await fb.route('**/openlibrary.org/api/books*', (r) => r.fulfill({ json: {} }));
    await fb.route('**/openlibrary.org/isbn/*', (r) => r.fulfill({ status: 404, body: '' }));
    await fb.route('**/openlibrary.org/works/*', (r) => r.fulfill({ status: 404, body: '' }));
    await fb.route('**/openlibrary.org/search.json*', (r) => r.fulfill({ json: { docs: [] } }));
    await fb.route('**googleapis.com/books/v1/volumes*', (r) => r.fulfill({ json: GB_VOLUMES }));
    await fb.route('**/books.google.com/**', (r) =>
      r.fulfill({ body: COVER_PNG, contentType: 'image/png' }));

    const p2 = await fb.newPage();
    const errs2 = [];
    p2.on('pageerror', (e) => errs2.push(e.message));
    await p2.goto(BASE + '/', { waitUntil: 'networkidle' });
    await p2.click('.tab[data-tab="settings"]');
    await p2.setInputFiles('#gr-file', path.join(DIR, 'goodreads-sample.csv'));
    await p2.waitForSelector('.sheet');
    await p2.click('.sheet__foot .btn--primary');
    await p2.waitForTimeout(600);

    await p2.click('#enrich-btn');
    await p2.waitForFunction(
      () => /^Done\.|Nothing is coming back/.test(document.getElementById('enrich-status')?.textContent || ''),
      null, { timeout: 90000 });
    const fbStatus = await p2.locator('#enrich-status').innerText();
    check('falls through to Google when Open Library has no cover',
      /^Done\./.test(fbStatus) && Number((fbStatus.match(/(\d+) updated/) || [0, 0])[1]) > 0, fbStatus);

    const verified = await p2.evaluate(async () => {
      const db = await import('./js/db.js');
      const all = await db.allBooks();
      return all.filter((b) => b.coverVerified && /google/.test(b.coverUrl)).length;
    });
    check('the Google cover URL is stored as verified', verified > 0, 'saw ' + verified);
    check('no errors in the fallback path', errs2.length === 0, errs2.join(' | '));
    await fb.close();
  }

  console.log('\n— dark mode —');
  await ctx.close();
  const darkCtx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    colorScheme: 'dark',
  });
  await darkCtx.route('**/covers.openlibrary.org/**', (r) => r.fulfill({ body: COVER_PNG, contentType: 'image/png' }));
  const dark = await darkCtx.newPage();
  await dark.goto(BASE + '/', { waitUntil: 'networkidle' });
  await dark.waitForTimeout(500);
  const bg = await dark.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('dark theme applies', bg === 'rgb(23, 19, 16)', bg);
  await dark.screenshot({ path: path.join(SHOTS, '09-dark.png') });
  await darkCtx.close();

  await browser.close();
  server.close();

  console.log(`\n${passes.length} passed, ${failures.length} failed`);
  if (errors.length) console.log('\nRuntime errors seen:\n' + errors.join('\n'));
  if (failures.length) { console.log('\nFailures:\n- ' + failures.join('\n- ')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
