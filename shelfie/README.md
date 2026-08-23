# Shelfie

A personal library for your iPhone. Scan the barcode on a book, it appears on a
shelf. Everything is stored on your phone — no account, no server, no monthly bill.

- **Scan** the ISBN barcode with the camera, or type it, or search by title
- **Shelves** — a wooden-shelf view and a cover grid, grouped by series, author or genre
- **Search** by title, author, series, genre or ISBN
- **Rate and review** every book, half-stars included
- **Read, TBR, DNF, Reading** — and rereads keep every set of dates, not just the last
- **Import** a Goodreads export, ratings and reviews and all
- **Works offline** once it has loaded

---

## Putting it on your phone

### 1. Publish it (once, on a computer)

1. Go to [github.com/new](https://github.com/new), name the repository `shelfie`,
   set it to **Public** (GitHub Pages is only free on public repos), and create it.
2. On the new repo's page, click **uploading an existing file**, then drag in
   everything from this folder — `index.html`, `manifest.webmanifest`, `sw.js`, and
   the `css`, `js`, `icons` and `vendor` folders. Commit.
3. Go to **Settings → Pages**. Under "Build and deployment", set Source to
   **Deploy from a branch**, branch `main`, folder `/ (root)`. Save.
4. Wait a minute or two. Your app is at `https://YOUR-USERNAME.github.io/shelfie/`.

The `https` matters: iOS will not open the camera for a page served over plain http.

### 2. Add it to your Home Screen

1. Open that link in **Safari** on your iPhone (it must be Safari, not Chrome).
2. Tap the Share button, then **Add to Home Screen**.
3. Open it from the icon. Tapping Add opens the camera. Allow it.

### 3. Bring your Goodreads books over

On a computer: Goodreads → My Books → Import and Export → **Export Library**.
Email or AirDrop the CSV to your phone, then in Shelfie go to **Settings →
Choose Goodreads CSV**. Afterwards run **Fetch covers & genres** — the export has
no cover art, so Shelfie downloads it.

---

## Backups matter

The library lives in your phone's browser storage. That is fast, private and free,
but it is one device, and iOS can clear storage for sites you have not opened in a
long while. Shelfie asks iOS to mark its data permanent, which usually works once
the app is on your Home Screen — but do this anyway:

**Settings → Save a backup file**, every so often. Put the file in iCloud Drive or
email it to yourself. It contains every book, cover, rating, review and date, and
**Restore from a backup** puts it all back — on this phone or a new one.

---

## If the camera misbehaves

iOS is genuinely unreliable about camera permission for Home Screen web apps: it
tends to re-ask on every launch, and some iOS releases have broken it outright.
Shelfie handles this three ways:

1. If the camera fails while running from the Home Screen, an **Open in Safari
   instead** button appears. The camera is more reliable there.
2. **Type the ISBN** always works. Tap and hold the ISBN box and choose
   **Scan Text** to have iOS read the number off the back cover with the camera.
3. **Search by title** needs no barcode at all — useful for older books whose
   barcodes predate ISBNs.

If you would rather the app always ran in Safari (permission then sticks), delete
this line from `index.html` and re-upload it:

```html
<meta name="apple-mobile-web-app-capable" content="yes">
```

You keep the Home Screen icon; it just opens in a Safari tab instead of full screen.

---

## Where the book data comes from

[Open Library](https://openlibrary.org) and [Google Books](https://developers.google.com/books).
Both are free and need no API key. Open Library is better at series and page counts;
Google Books has cleaner categories and subtitles. Shelfie asks both and merges the
answers, so a gap in one is usually filled by the other.

Neither is perfect. Series and genre are the fields most often wrong or missing —
every book's ⋯ menu has **Edit details** for exactly that reason, and the fields
remember what you have already typed elsewhere in your library.

---

## Running it locally

```bash
npm install     # only needed for the tests
npm start       # http://localhost:8099
npm test        # unit tests + a full browser run-through
```

`localhost` counts as a secure context, so the camera works in local development too.

## What is in here

| Path | What it does |
| --- | --- |
| `index.html` | App shell |
| `js/db.js` | IndexedDB: books, covers, backup and restore |
| `js/store.js` | The library in memory — search, grouping, sorting, stats |
| `js/lookup.js` | Open Library + Google Books, ISBN maths, genre normalising |
| `js/scanner.js` | Camera barcode scanning |
| `js/goodreads.js` | Goodreads CSV reader |
| `js/view-*.js` | The four screens |
| `sw.js` | Offline cache — **bump `CACHE` whenever you change a file** |
| `vendor/zxing.min.js` | Barcode decoder, vendored so the app works offline |

No build step, no framework. Edit a file, re-upload it, done.
