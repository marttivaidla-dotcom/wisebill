import { NextResponse } from "next/server";
import { parseAccounts, parseRegister, parseSpreadsheet } from "@/lib/parsers/spreadsheet";
import { parseInvoiceText } from "@/lib/parsers/text";
import type { Invoice, InvoiceDirection } from "@/lib/types";

// Vercel Hobby: Node runtime, max 4.5 MB päringu keha. Faile ei salvestata – töötlus toimub mälus.
export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_BYTES = 4 * 1024 * 1024;

/**
 * POST multipart/form-data:
 *  - file: Excel/CSV/PDF   VÕI   text: brauseris OCR-itud tekst (pildid)
 *  - direction: "sales" | "purchase"
 *  - kind: "invoice" (vaikimisi) | "accounts" (kontoplaan) | "register" (Booksi arvete nimekiri)
 */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const direction: InvoiceDirection = form.get("direction") === "purchase" ? "purchase" : "sales";
    const text = form.get("text");
    const name = String(form.get("filename") ?? "dokument");

    if (typeof text === "string") {
      return NextResponse.json({ invoices: [parseInvoiceText(text, name, direction)] });
    }

    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Fail puudub" }, { status: 400 });
    if (file.size > MAX_BYTES) return NextResponse.json({ error: "Fail on suurem kui 4 MB" }, { status: 413 });

    const buf = Buffer.from(await file.arrayBuffer());
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    const kind = String(form.get("kind") ?? "invoice");
    const isSheet = ["xlsx", "xls", "csv", "ods"].includes(ext);
    if (kind === "accounts" || kind === "register") {
      if (!isSheet) return NextResponse.json({ error: "Oodatud Excel või CSV fail" }, { status: 415 });
      return NextResponse.json(
        kind === "accounts"
          ? { accounts: parseAccounts(buf, file.name) }
          : { entries: parseRegister(buf, file.name, direction) },
      );
    }
    let invoices: Invoice[];

    if (isSheet) {
      invoices = parseSpreadsheet(buf, file.name, direction);
    } else if (ext === "pdf" || file.type === "application/pdf") {
      // Laetakse ainult PDF-i jaoks: kui pdf.js-iga on probleem, töötavad Excel/CSV edasi.
      // CanvasFactory annab serverless-keskkonnas puuduva DOMMatrix'i (pdf-parse troubleshooting).
      const { CanvasFactory } = await import("pdf-parse/worker");
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: buf, CanvasFactory });
      try {
        const { text: pdfText } = await parser.getText();
        if (pdfText.replace(/\s/g, "").length < 30)
          return NextResponse.json(
            { error: "PDF-is pole teksti (skaneeritud). Lae see pildina üles, siis tehakse OCR." },
            { status: 422 },
          );
        invoices = [parseInvoiceText(pdfText, file.name, direction)];
      } finally {
        await parser.destroy();
      }
    } else {
      return NextResponse.json({ error: `Tundmatu failitüüp: .${ext}` }, { status: 415 });
    }

    return NextResponse.json({ invoices });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
