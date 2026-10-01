// Genereerib minimaalse tekstipõhise PDF-i (test/fixtures/arve.pdf) parseri testimiseks.
// Käivita: node test/make-pdf-fixture.mjs
import { writeFileSync } from "node:fs";

const lines = [
  "Puit & Ehitus OU",
  "Reg. kood: 12345678  KMKR: EE101234567",
  "Arve nr: A-2001",
  "Arve kuupaev: 01.10.2026",
  "Maksetahtaeg: 15.10.2026",
  "Klient: Wise Tag OU",
  "Registrikood: 87654321",
  "Summa ilma km: 1 250,00",
  "Kaibemaks 24%: 300,00",
  "Kokku tasuda: 1 550,00 EUR",
  "IBAN EE38 2200 2210 2014 5685",
];
const pdfStr = (s) => "(" + s.replace(/([()\\])/g, "\\$1") + ")";
const content = "BT /F1 11 Tf 50 780 Td 14 TL " + lines.map((l) => `${pdfStr(l)} Tj T*`).join(" ") + " ET";
const objs = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];
let out = "%PDF-1.4\n";
const offsets = [];
objs.forEach((o, i) => {
  offsets.push(out.length);
  out += `${i + 1} 0 obj\n${o}\nendobj\n`;
});
const xref = out.length;
out +=
  `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
  offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
  `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(new URL("./fixtures/arve.pdf", import.meta.url), out, "latin1");
