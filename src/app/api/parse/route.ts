import { NextResponse } from "next/server";
import { parseInvoiceText } from "@/lib/parsers/text";

// Vercel Hobby: Node runtime, max 4.5 MB päringu keha. Faile ei salvestata – töötlus toimub mälus.
export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_BYTES = 4 * 1024 * 1024;

/**
 * POST multipart/form-data:
 *  - file: PDF   VÕI   text + filename: brauseris OCR-itud tekst (pildid)
 * -> { invoice }
 */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const text = form.get("text");
    if (typeof text === "string") {
      return NextResponse.json({ invoice: parseInvoiceText(text, String(form.get("filename") ?? "pilt")) });
    }

    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Fail puudub" }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ error: "Fail on suurem kui 4 MB" }, { status: 413 });
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf")
      return NextResponse.json({ error: "Oodatud PDF või pilt" }, { status: 415 });

    // Laetakse ainult PDF-i jaoks. CanvasFactory annab serverless-keskkonnas puuduva DOMMatrix'i (pdf-parse troubleshooting).
    const { CanvasFactory } = await import("pdf-parse/worker");
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: Buffer.from(await file.arrayBuffer()), CanvasFactory });
    try {
      const { text: pdfText } = await parser.getText();
      if (pdfText.replace(/\s/g, "").length < 30)
        return NextResponse.json(
          { error: "PDF-is pole teksti (skaneeritud). Tee sellest pilt (nt ekraanitõmmis) ja lae see üles – siis tehakse tekstituvastus." },
          { status: 422 },
        );
      return NextResponse.json({ invoice: parseInvoiceText(pdfText, file.name) });
    } finally {
      await parser.destroy();
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
