/* scanner.js — camera ISBN barcode scanning via ZXing.
 *
 * iOS notes that took a while to learn the hard way:
 *  - getUserMedia only works over https (or localhost).
 *  - The <video> must be muted + playsinline or iOS refuses to play it inline.
 *  - Permission must be triggered by a real tap, never on page load.
 *  - Home-screen "standalone" mode re-asks for permission on every launch,
 *    so we always keep the manual-entry path one tap away.
 */

const FORMATS = () => {
  const F = window.ZXing.BarcodeFormat;
  return [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E];
};

export class BarcodeScanner {
  constructor(videoEl) {
    this.video = videoEl;
    this.reader = null;
    this.controls = null;
    this.running = false;
    this.lastCode = null;
    this.lastAt = 0;
  }

  static get supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.ZXing);
  }

  /** @param {(isbn: string) => void} onResult */
  async start(onResult, onError) {
    if (this.running) return;
    if (!BarcodeScanner.supported) {
      onError && onError(new Error('This browser cannot open the camera. Enter the ISBN by hand instead.'));
      return;
    }

    const { BrowserMultiFormatReader, DecodeHintType } = window.ZXing;
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, FORMATS());
    /* TRY_HARDER re-scans each frame at multiple rotations and scales. It is
     * meant for damaged or skewed codes; a book barcode held up to the camera
     * is neither, and the extra work is a large part of why a long scanning
     * session heats the phone. */

    // ~5 decodes a second is still faster than anyone can turn a book over.
    this.reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 200 });

    const constraints = {
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        // 720p costs roughly four times the pixels of 640x480 to decode, and a
        // 13-digit barcode needs nowhere near that. Big battery/heat saving.
        width: { ideal: 960 },
        height: { ideal: 540 },
        frameRate: { ideal: 15, max: 24 },
      },
    };

    try {
      this.running = true;
      this.controls = await this.reader.decodeFromConstraints(
        constraints,
        this.video,
        (result, err) => {
          if (!result) {
            // NotFoundException fires constantly while hunting; ignore it.
            void err;
            return;
          }
          const text = result.getText().replace(/[^0-9X]/gi, '');
          const now = Date.now();
          // Debounce: the same barcode decodes many times a second.
          if (text === this.lastCode && now - this.lastAt < 2500) return;
          this.lastCode = text;
          this.lastAt = now;
          buzz();
          onResult(text);
        }
      );
    } catch (e) {
      this.running = false;
      onError && onError(friendlyCameraError(e));
    }
  }

  stop() {
    this.running = false;
    try {
      if (this.controls && this.controls.stop) this.controls.stop();
    } catch (_) { /* already gone */ }
    try {
      if (this.reader && this.reader.reset) this.reader.reset();
    } catch (_) { /* already gone */ }
    // Belt and braces: make sure the camera light actually goes off.
    try {
      const s = this.video && this.video.srcObject;
      if (s && s.getTracks) s.getTracks().forEach((t) => t.stop());
      if (this.video) this.video.srcObject = null;
    } catch (_) { /* ignore */ }
    this.controls = null;
    this.reader = null;
  }
}

function buzz() {
  try {
    if (navigator.vibrate) navigator.vibrate(40);
  } catch (_) { /* iOS ignores this, that's fine */ }
}

function friendlyCameraError(e) {
  const name = (e && e.name) || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new Error('Camera access was blocked. Allow the camera for this site in Settings → Safari, then try again — or just type the ISBN in.');
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new Error('No camera found on this device.');
  }
  if (name === 'NotReadableError') {
    return new Error('Another app is using the camera. Close it and try again.');
  }
  return new Error((e && e.message) || 'The camera would not start.');
}

/**
 * Turn a raw barcode into an ISBN.
 * Book barcodes are EAN-13 starting 978/979; the sticker underneath is often
 * a price/UPC code, which we ignore rather than looking up as garbage.
 */
export function barcodeToIsbn(code) {
  const s = String(code || '').replace(/[^0-9X]/gi, '');
  if (s.length === 13 && /^97[89]/.test(s)) return s;
  if (s.length === 10) return s;
  return null;
}
