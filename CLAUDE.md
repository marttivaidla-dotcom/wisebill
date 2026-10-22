# WiseBill

Ostuarve PDF või pilt → eelvaade/parandus brauseris → Eesti e-arve 1.2 XML → **Billberry** `POST /invoices/received`
(firma enda API võtmega). Kasutajaliides ja koodikommentaarid on eesti keeles.

Skoobist väljas (võtame üles, kui tekib vajadus): Booksi kontoplaan ja kulukontod, tarnijate kontaktid,
müügiarved, Excel/CSV import, pangaväljavõtted, Books REST API, Billberry → Books ühendus, kasutajakontod (Supabase).

## Piirangud
- **0 € / kuu**: GitHub + Vercel Hobby. Ühtegi tasulist API-t (ka OCR/AI) ei kasutata.
- Vercel Hobby: päringu keha ≤ 4,5 MB, funktsiooni kestus piiratud → OCR käib **brauseris**
  (Tesseract.js, keeled `est+eng`), server saab ainult tuvastatud teksti.
- Faile ei salvestata; töötlus toimub mälus. Serveris pole andmebaasi.

## Arhitektuur
- `src/lib/types.ts` – `Invoice` (alati ostuarve: seller = tarnija, buyer = valitud firma), `Company`, `SentEntry`.
- `src/lib/parsers/text.ts` – PDF/OCR tekstist: summad kolmikust neto + KM = kokku (sildid ja numbrid võivad
  olla eri veergudes), read (netod annavad kokku arve neto), osapooled registrikoodi ümbrusest → `inv.candidates`.
  `common.ts` – ET numbrid/kuupäevad.
- `src/lib/prepare.ts` – `prepareForCompany()`: oma firma tuvastatakse reg.koodi/KMKR-i/nime järgi, tarnija = teine.
- `src/lib/vat.ts` – summad arvutatakse alati ise (`recalcRow`, `totals`, KM määrade kaupa summalt); `invoiceIssues`.
- `src/lib/export/earve.ts` – e-arve v1.2 XML. **XSD nõuab elementide järjekorda – ära muuda.**
  Ametlik skeem: `schema/e-invoice_ver1.2.EN.xsd`; test valideerib XML-i selle vastu (xmllint-wasm).
- `src/lib/billberry.ts` + `src/app/api/billberry/route.ts` – firma API võti (Billberry: Konto ja seaded → API võtmed),
  `POST /invoices/received`, üks arve päringu kohta. Billberry kontrollib `<Invoice regNumber>` = võtme firma reg.kood.
  Firma võtmega variant pole salvestatud OpenAPI-s (`schema/billberry-openapi.yaml`), kinnitas Billberry arendaja.
  Server on ainult vahendaja (CORS). Ilma `X-Forward`-ita jääb arve firma Billberry kontole.
- `src/lib/duplicates.ts` – sama tarnija + normaliseeritud arve nr = "kindel"; sama summa ±3 päeva = "võimalik".
  Billberry ise topelt üleslaadimist ei takista.
- `src/lib/store.ts` – brauseri localStorage: firmad (koos Billberry võtmega), aktiivne firma, saadetud arved;
  varukoopia JSON. Vana v1 (Booksi kontoplaaniga) formaat võetakse automaatselt üle.
- `src/lib/ariregister.ts` + `api/ariregister` – äriregistri tasuta otsing; /firmad täidab reg.koodi, KMKR-i, aadressi.
- `src/lib/auth.ts` + `src/proxy.ts` + `api/login` – üks parool (env `WISEBILL_PASSWORD`), küpsises HMAC.
  Kui env puudub, on rakendus avatud (kohalik arendus).
- `src/app/api/parse/route.ts` – Node runtime, `pdf-parse` v2, `serverExternalPackages` next.config.ts-is vajalik.
- Lehed: `/` (ostuarved), `/firmad` (firma, Billberry võti, saadetud arved), `/login`.

## Billberry / e-arve nõuded
- `sellerRegnumber` kohustuslik ja = `<SellerParty><RegNumber>`; `regNumber` = ostja = võtme firma.
- Header: `FileId` ≤ 20 märki, `Version` = `1.2`. `Payable=YES` nõuab `PayDueDate`. Rea `Description` ei tohi olla tühi.
- Neto + KM = kokku peab klappima sendi pealt (tarnija võib KM-i arvutada ridade kaupa → 1 sendi hoiatus).

## Käsud
- `npm run dev` · `npm run build` · `npm test` (tsx + node:test, fixtures `test/fixtures/`)
- PDF fixture: `node test/make-pdf-fixture.mjs`

## Teadaolevad lüngad
- Billberrysse pole veel päris arvet saadetud (testkeskkonnas vastab aadress firma võtmega).
- Kreeditarved (`Type CRE`) ja manus (originaal-PDF `<AttachmentFile>`) puuduvad.
- Vercel ei käivita GitHubi pushi peale deployd – deploy käsitsi (Vercel → Create Deployment).
