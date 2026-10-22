# WiseBill

Algdokumendid (PDF, Excel, CSV, pildid) → eelvaade/parandus brauseris → **Excellent Books** import
(e-arve XML: ostuarved Billberry kaudu, müügiarved failina). Kasutajaliides ja koodikommentaarid on eesti keeles.

## Piirangud
- **0 € / kuu**: GitHub + Vercel Hobby + Supabase Free. Ühtegi tasulist API-t (ka OCR/AI) ei kasutata.
- Vercel Hobby: päringu keha ≤ 4,5 MB, funktsiooni kestus piiratud → raske töö (OCR) käib **brauseris**
  (Tesseract.js, keeled `est+eng`), server saab ainult tuvastatud teksti.
- Faile ei salvestata; töötlus toimub mälus. Supabase'is on ainult seaded/register (firmad, kontoplaanid,
  vastendused, Billberry võtmed, imporditud arvete register, kasutajad).

## Arhitektuur
- `src/lib/types.ts` – ühtne `Invoice` mudel, kõik parserid ja eksportijad räägivad seda.
- `src/lib/parsers/` – `spreadsheet.ts` (xlsx/csv, päise sünonüümid ET/EN, grupeerib arve nr järgi),
  `text.ts` (PDF/OCR tekstist regexid; read koondatakse KM-määra kaupa), `common.ts` (ET numbrid/kuupäevad).
- `src/lib/vat.ts` – summad arvutatakse alati ise (`recalcRow`, `totals`); KM arvutatakse määrade kaupa summalt.
- `src/lib/export/earve.ts` – Eesti e-arve v1.2 XML. **XSD nõuab elementide järjekorda – ära muuda.**
  Ametlik skeem: `schema/e-invoice_ver1.2.EN.xsd`; test valideerib iga XML-i selle vastu (xmllint-wasm).
  Rea konto: `ItemEntry/Accounting/JournalEntry/GeneralLedger` (enne Description'it).
- `src/lib/mapping.ts` – firma-põhised vastendused (Booksi kood, artikkel, konto hankija+kirjelduse järgi);
  `prepareForCompany()` täidab firma enda andmed ja õpitud väärtused.
- `src/lib/accounts.ts` – näidiskontoplaan, konto tüübi tuletamine koodist.
- `src/lib/duplicates.ts` – duplikaadid firma piires: "kindel" = sama vastaspool + normaliseeritud arve nr;
  "võimalik" = sama summa ±3 päeva. Vastaspool reg.koodi järgi, puudumisel nimi ilma OÜ/AS-ita (nagu Books).
- `src/lib/store.ts` – KÕIK püsiandmed Supabase'is (async). Skeem + RLS: `schema/supabase.sql`
  (korduvkäivitatav). Kasutaja näeb ainult firmasid, mille liige ta on (`company_members`, kõik liikmed võrdsed);
  firma luuakse `create_company()`, jagatakse `share_company()` RPC-ga. Aktiivne firma = localStorage.
- Kasutajad: e-post + parool (`@supabase/ssr`, seanss küpsistes). Avalik registreerimine kinni; admin
  (`profiles.is_admin`) loob kasutaja ajutise parooliga `/api/admin/users` kaudu (service role) – e-kirju ei
  saadeta, sest Supabase'i tasuta SMTP ei saada võõrastele aadressidele. Iga API-tee algab `requireUser()`.
- Env: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (Vercelis ja .env.local).
- Lehed: `/` (import), `/firmad` (firmad, kontoplaan, Billberry, register, liikmed), `/kasutajad` (admin), `/konto`.
- `src/lib/billberry.ts` + `src/app/api/billberry/route.ts` – ostuarve Billberry kaudu Booksi: **firma enda API võti**
  (Billberry: Konto ja seaded -> API võtmed; hoitakse firma seadetes, mitte env-is) ja `POST /invoices/received`,
  üks arve päringu kohta. Billberry kontrollib, et `<Invoice regNumber>` = võtme firma reg.kood (meil ostja = firma).
  Kinnitanud Billberry arendaja; salvestatud OpenAPI-s seda firma-võtme varianti pole. Server on ainult vahendaja (CORS).
- `src/lib/ariregister.ts` + `src/app/api/ariregister/route.ts` – äriregistri tasuta avalik otsing
  (`/est/api/autocomplete`, JSON) ja KMKR firma avalikult lehelt (HTML-ist regexiga, kehtib kui periood "– ..").
  /firmad: nime väljal otsing, valides täidetakse reg.kood, KMKR, aadress.
- `src/app/api/parse/route.ts` – Node runtime, `pdf-parse` v2 (`new PDFParse({data}).getText()`),
  `serverExternalPackages: ["pdf-parse"]` on next.config.ts-is vajalik.

## Booksi reeglid
- Standard Books 8 (excellent.ee/pdf/earved_books8.pdf): tarnija e-arved tulevad **e-arve operaatori** kaudu
  (Billberry on tasuta) registrisse Ostuarved > Registrid > Tarnija e-arved, sealt Koosta > Ostuarve.
  Tarnija leitakse järjekorras: ERP kood, Reg.nr., KMKR, nimi ilma ettevõtlusvormita.
  Kulukontod ja summad võetakse e-arvelt. Failist (kettalt) XML-i impordi teed see juhend ei kirjelda – kinnitamata.
- Kliendid/hankijad vastendatakse registrikoodi järgi (`RegNumber`, `serviceId` = Booksi kood);
  artiklid `SellerProductId` järgi. Puuduv vaste = Booksi impordiviga → `validate()` blokeerib ekspordi.
- Arve numbrid peavad mahtuma Booksi impordi numbriseeriasse.
- Neto + KM = kokku (`TotalSum`/PayVal) peab klappima sendi pealt.
- KM määrad: 24 (standard alates 07/2025), 13, 9, 0 jne.

## Käsud
- `npm run dev` · `npm run build` · `npm test` (tsx + node:test, fixtures `test/fixtures/`)
- PDF fixture: `node test/make-pdf-fixture.mjs`

## Teadaolevad lüngad
- `xlsx` paigaldatakse SheetJS CDN-ist (npm-i versioon on vana ja haavatav) – ära vaheta npm-i omaga.
- XML vastab ametlikule XSD-le, aga pole päris Booksi impordiga testitud.
- Billberry: aadress vastab testkeskkonnas firma võtmega (tühi XML -> 422), päris arvega veel proovimata.
  Kinnitamata, kas kulukontod (`GeneralLedger`) ja `serviceId` jõuavad Booksi. Müügiarved ainult XML-failina.
- Skoobist väljas: pangaväljavõtted, Books REST API ning Billberry → Books ühendus (selle seadistab firma ise).
  Fookus: XML jõuab Billberrysse korrektselt.
