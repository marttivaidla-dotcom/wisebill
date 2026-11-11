/**
 * Pildist OCR-i fixture sama eeltöötlusega nagu brauser (page.tsx): digitaalne pilt halltoonis suurendatult,
 * foto lävendatult; madala kindluse korral teised variandid, kõrgeim kindlus võidab.
 *   npx tsx test/make-ocr-fixture.mts <pilt> > test/fixtures/ocr/<nimi>.txt
 */
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createWorker } from "tesseract.js";
import { binarize, digitalScale, isDigital, LOW_CONFIDENCE, ocrScale, type Pixels } from "../src/lib/ocr-prep";

const img = await loadImage(process.argv[2]);
const raw = createCanvas(img.width, img.height);
raw.getContext("2d").drawImage(img, 0, 0);
const digital = isDigital(raw.getContext("2d").getImageData(0, 0, img.width, img.height) as unknown as Pixels);

type Prep = "digital" | "photo" | "photo-blur";
function prepare(prep: Prep): Buffer {
  const s = prep === "digital" ? digitalScale(img.width, img.height) : ocrScale(img.width, img.height);
  const c = createCanvas(Math.round(img.width * s), Math.round(img.height * s));
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, c.width, c.height);
  if (prep !== "digital") {
    const d = ctx.getImageData(0, 0, c.width, c.height);
    binarize(d as unknown as Pixels, prep === "photo-blur" ? 1 : 0);
    ctx.putImageData(d, 0, 0);
  }
  return c.toBuffer("image/png");
}

const worker = await createWorker(["est", "eng"]);
const order: Prep[] = digital ? ["digital", "photo", "photo-blur"] : ["photo", "photo-blur", "digital"];
let { data } = await worker.recognize(prepare(order[0]));
for (const prep of order.slice(1)) {
  if (data.confidence >= LOW_CONFIDENCE) break;
  const next = (await worker.recognize(prepare(prep))).data;
  if (next.confidence > data.confidence) data = next;
}
await worker.terminate();
console.error(`${digital ? "digitaalne" : "foto"}, kindlus ${data.confidence}`);
process.stdout.write(data.text);
