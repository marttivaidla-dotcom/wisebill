/**
 * Pildi eeltöötlus enne OCR-i (brauseris canvas'ega, testis @napi-rs/canvas'ega – sama kood).
 * Fotod (kortsus kassatšekk, ebaühtlane valgus, mustriline taust) annavad Tesseractile palju müra:
 * halltoon -> kohalik (adaptiivne) lävendamine: piksel on tekst, kui see on ümbruse keskmisest selgelt tumedam.
 * Nii kaob varjude ja tausta mõju ning jääb must tekst valgel.
 */

export interface Pixels {
  data: Uint8ClampedArray; // RGBA
  width: number;
  height: number;
}

/** Halltoon + Bradley adaptiivne lävendamine (integraalpildiga, O(n)). Muudab data't kohapeal. */
export function binarize(img: Pixels, windowFrac = 1 / 16, darker = 0.15): Pixels {
  const { data, width: w, height: h } = img;
  const gray = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  // integraalpilt: (w+1) x (h+1)
  const W = w + 1;
  const integral = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      integral[(y + 1) * W + x + 1] = integral[y * W + x + 1] + row;
    }
  }
  const r = Math.max(4, Math.round((Math.max(w, h) * windowFrac) / 2));
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const sum = integral[y1 * W + x1] - integral[y0 * W + x1] - integral[y1 * W + x0] + integral[y0 * W + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      const v = gray[y * w + x] < mean * (1 - darker) ? 0 : 255;
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return img;
}

/** Kui suureks pilt OCR-i jaoks skaleerida: väike pilt suuremaks (tähed ≥ ~20 px), väga suur väiksemaks. */
export function ocrScale(width: number, height: number): number {
  const long = Math.max(width, height);
  if (long < 2000) return Math.min(3, 2400 / long);
  if (long > 4000) return 4000 / long;
  return 1;
}
