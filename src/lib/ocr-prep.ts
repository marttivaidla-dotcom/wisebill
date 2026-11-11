/**
 * Pildi eeltöötlus enne OCR-i (brauseris canvas'ega, testis @napi-rs/canvas'ega – sama kood).
 * Fotod (kortsus kassatšekk, ebaühtlane valgus, mustriline taust) annavad Tesseractile palju müra:
 * halltoon -> kohalik (adaptiivne) lävendamine: piksel on tekst, kui see on ümbruse keskmisest selgelt tumedam.
 * Nii kaob varjude ja tausta mõju ning jääb must tekst valgel.
 * Ekraanilt pildistatud arvel on moiree-muster: seda lävendamine võimendab, kerge hägustus (blur) enne kaotab selle.
 * Selge pildi tekst blur'iga veidi halveneb, seega on see teine katse, kui esimese kindlus on madal.
 */

/** Tesseracti kindlus (0–100), millest madalama korral proovitakse pilti hägustatult uuesti. */
export const LOW_CONFIDENCE = 60;

export interface Pixels {
  data: Uint8ClampedArray; // RGBA
  width: number;
  height: number;
}

/** Iga piksli ümbruse (raadius r) keskmine integraalpildiga, O(n). */
function boxMean(gray: Float64Array, w: number, h: number, r: number): Float64Array {
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
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const sum = integral[y1 * W + x1] - integral[y0 * W + x1] - integral[y1 * W + x0] + integral[y0 * W + x0];
      out[y * w + x] = sum / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/** Halltoon + (soovi korral kerge hägustus) + Bradley adaptiivne lävendamine. Muudab data't kohapeal. */
export function binarize(img: Pixels, blur = 0, windowFrac = 1 / 16, darker = 0.15): Pixels {
  const { data, width: w, height: h } = img;
  const raw = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) raw[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  const gray = blur > 0 ? boxMean(raw, w, h, blur) : raw;
  const means = boxMean(gray, w, h, Math.max(4, Math.round((Math.max(w, h) * windowFrac) / 2)));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x] < means[y * w + x] * (1 - darker) ? 0 : 255;
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

/**
 * Digitaalne pilt (ekraanitõmmis, salvestatud arve): suurem osa pikslitest on puhas valge taust.
 * Sellist pilti lävendamine rikub (peen kiri murdub) – Tesseract loeb seda paremini halltoonis ja rohkem suurendatult.
 * Foto (paber, vari, kortsud) taust pole kunagi ühtlaselt valge.
 */
export function isDigital(img: Pixels): boolean {
  const { data, width, height } = img;
  const n = width * height;
  const step = Math.max(1, Math.floor(n / 200_000)); // valim
  let white = 0, total = 0;
  for (let i = 0; i < n; i += step, total++)
    if (data[i * 4] >= 248 && data[i * 4 + 1] >= 248 && data[i * 4 + 2] >= 248) white++;
  return white / total > 0.5;
}

/** Digitaalse pildi skaala: pikem külg ~4000 px (väike 650 px arve-pilt ~6×) – väikesed tähed loetakse siis õigesti. */
export function digitalScale(width: number, height: number): number {
  const long = Math.max(width, height);
  return long < 4000 ? Math.min(6, 4000 / long) : 4000 / long;
}
