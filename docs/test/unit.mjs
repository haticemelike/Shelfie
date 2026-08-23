/* Unit tests for the fiddly pure logic: ISBN maths, series parsing,
 * genre mapping and the Goodreads CSV reader. Run with: npm run test:unit */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

const { normaliseGenres, parseSeries, parseTitleSeries, toIsbn13, isValidIsbn, cleanIsbn } =
  await import('../js/lookup.js');
const { parseCSV, parseGoodreads, rowToBook } = await import('../js/goodreads.js');

let failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); }
}

console.log('\n— ISBN —');
t('validates a real ISBN-13', () => assert.equal(isValidIsbn('9780765326355'), true));
t('validates a real ISBN-10', () => assert.equal(isValidIsbn('0765326353'), true));
t('validates an X check digit', () => assert.equal(isValidIsbn('080442957X'), true));
t('rejects a made-up number', () => assert.equal(isValidIsbn('1234567890123'), false));
t('rejects a wrong length', () => assert.equal(isValidIsbn('97807653263'), false));
t('converts ISBN-10 to 13', () => assert.equal(toIsbn13('0765326353'), '9780765326355'));
t('leaves an ISBN-13 alone', () => assert.equal(toIsbn13('9780765326355'), '9780765326355'));
t('strips hyphens and spaces', () => assert.equal(cleanIsbn('978-0-7653-2635-5'), '9780765326355'));

console.log('\n— series parsing —');
t('"Name #2"', () => assert.deepEqual(parseSeries('The Stormlight Archive #2'),
  { series: 'The Stormlight Archive', seriesIndex: 2 }));
t('"Name, Book 5"', () => assert.deepEqual(parseSeries('Discworld, Book 5'),
  { series: 'Discworld', seriesIndex: 5 }));
t('"Name Vol. 3"', () => assert.deepEqual(parseSeries('Saga Vol. 3'),
  { series: 'Saga', seriesIndex: 3 }));
t('half-numbered entries', () => assert.deepEqual(parseSeries('Wayfarers #2.5'),
  { series: 'Wayfarers', seriesIndex: 2.5 }));
t('series with no number', () => assert.deepEqual(parseSeries('The Broken Earth'),
  { series: 'The Broken Earth', seriesIndex: null }));
t('pulls series out of a Goodreads title', () => {
  const r = parseTitleSeries('Words of Radiance (The Stormlight Archive, #2)');
  assert.equal(r.series, 'The Stormlight Archive');
  assert.equal(r.seriesIndex, 2);
  assert.equal(r.cleanTitle, 'Words of Radiance');
});
t('leaves a plain title alone', () => assert.equal(parseTitleSeries('Piranesi'), null));
t('does not mistake a subtitle for a series', () =>
  assert.equal(parseTitleSeries('Sapiens (A Brief History of Humankind)'), null));

console.log('\n— genres —');
const g = (subjects) => normaliseGenres(subjects);
t('"science fiction" does not also become Science', () =>
  assert.deepEqual(g(['science-fiction']), ['Science Fiction']));
t('"non-fiction" does not become Fiction', () =>
  assert.deepEqual(g(['non-fiction']), ['Nonfiction']));
t('self-help shelf maps correctly', () =>
  assert.ok(g(['non-fiction', 'self-help']).includes('Self-Help')));
t('splits a Google category path', () =>
  assert.deepEqual(g(['Fiction / Fantasy / Epic']), ['Fantasy']));
t('"ya" shorthand is understood', () =>
  assert.ok(g(['ya', 'contemporary']).includes('Young Adult')));
t('specific genres beat the bare "Fiction" tag', () => {
  const out = g(['Fiction', 'Fantasy', 'Epic']);
  assert.ok(out.includes('Fantasy'));
  assert.ok(!out.includes('Fiction'));
});
t('bare Fiction survives when nothing else matches', () =>
  assert.deepEqual(g(['Fiction']), ['Fiction']));
t('true crime is not filed under Mystery', () =>
  assert.deepEqual(g(['true-crime']), ['True Crime']));
t('historical fiction is not filed under History', () =>
  assert.deepEqual(g(['historical-fiction']), ['Historical Fiction']));
t('caps the list at four', () =>
  assert.ok(g(['fantasy', 'mystery', 'romance', 'horror', 'poetry', 'history']).length <= 4));
t('unknown shelves yield nothing', () =>
  assert.deepEqual(g(['favourites', 'owned', 'signed-copy']), []));

console.log('\n— CSV —');
t('handles quoted commas', () => {
  const rows = parseCSV('A,B\n"one, two",three\n');
  assert.deepEqual(rows, [{ A: 'one, two', B: 'three' }]);
});
t('handles escaped quotes', () => {
  const rows = parseCSV('A\n"she said ""hi"""\n');
  assert.equal(rows[0].A, 'she said "hi"');
});
t('handles newlines inside quotes', () => {
  const rows = parseCSV('A,B\n"line one\nline two",x\n');
  assert.equal(rows[0].A, 'line one\nline two');
  assert.equal(rows[0].B, 'x');
});
t('skips blank rows', () => assert.equal(parseCSV('A,B\n\n1,2\n').length, 1));

console.log('\n— Goodreads mapping —');
const csv = fs.readFileSync(path.join(DIR, 'goodreads-sample.csv'), 'utf8');
const { books } = parseGoodreads(csv);
const by = (title) => books.find((b) => b.title === title);

t('reads every row', () => assert.equal(books.length, 16));
t('strips the ="..." wrapper from ISBNs', () =>
  assert.equal(by('The Way of Kings').isbn13, '9780765326355'));
t('series comes out of the title', () => {
  const b = by('The Way of Kings');
  assert.equal(b.series, 'The Stormlight Archive');
  assert.equal(b.seriesIndex, 1);
});
t('a read count of 3 makes 3 finished sessions', () => {
  const b = by('The Way of Kings');
  assert.equal(b.sessions.filter((s) => s.finished).length, 3);
});
t('only the latest session carries a date', () => {
  const b = by('The Way of Kings');
  assert.equal(b.sessions.filter((s) => s.finish).length, 1);
  assert.equal(b.sessions.find((s) => s.finish).finish, '2019-04-23');
});
t('a dnf shelf overrides the "read" column', () => {
  const b = by('Wolf Hall');
  assert.equal(b.status, 'dnf');
  assert.equal(b.sessions[0].dnfAt, '2021-02-11');
});
t('to-read becomes TBR with no sessions', () => {
  const b = by('The Fault in Our Stars');
  assert.equal(b.status, 'tbr');
  assert.equal(b.sessions.length, 0);
});
t('currently-reading opens a session', () => {
  const b = by('Atomic Habits');
  assert.equal(b.status, 'reading');
  assert.equal(b.sessions[0].start, '2025-01-07');
});
t('review HTML is stripped to text', () => {
  const b = by('The Way of Kings');
  assert.ok(b.review.includes('Bridge Four'));
  assert.ok(!b.review.includes('<br'));
});
t('unrated books get null, not zero', () =>
  assert.equal(by('The Fault in Our Stars').rating, null));
t('additional authors are kept', () =>
  assert.deepEqual(by('The Girl with the Dragon Tattoo').authors,
    ['Stieg Larsson', 'Reg Keeland']));
t('original publication year wins over the reprint year', () =>
  assert.equal(by('The Hobbit').year, 1937));
t('private notes are carried over', () =>
  assert.ok(by('The Way of Kings').notes.includes('Reread before book 5')));
t('an empty row is ignored, not crashed on', () =>
  assert.equal(rowToBook({ Title: '' }), null));

console.log(failed ? `\n${failed} unit test(s) failed` : '\nall unit tests passed');
process.exit(failed ? 1 : 0);
