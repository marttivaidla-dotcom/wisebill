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
- Kassatšekid: KMKR ilma EE-ta, tšeki nr + kuupäev (ppkkaa) kassatabelist, read KM-ga summadest (allahindlus
  eelmise kauba juurde), makstud (kaart/sularaha) -> `paid`, e-arvel `Payable=NO`. OCR-i "UU/00" -> "OÜ".
- `src/lib/ocr-prep.ts` – pildi eeltöötlus enne Tesseracti (brauseris canvas). Digitaalne pilt (`isDigital`: > 50% puhast
  valget; ekraanitõmmis, salvestatud arve) halltoonis suurendatult ~4000 px (`digitalScale`) – **lävendamine rikub peent
  kirja**. Foto (kortsus tšekk, mustriline taust): skaleerimine + adaptiivne lävendamine. Kindlus < 60: teised variandid
  (hägustusega moiree vastu), kõrgem kindlus võidab. Fixture pildist samamoodi: `npx tsx test/make-ocr-fixture.mts <pilt>`,
  väljundid `test/fixtures/ocr/`.
- KM: kolmik neto + KM = kokku > määr tekstis > "käibemaksu pole mainitud" (paljas "KM" on OCR-i müra) = 0% (`noVatOnDoc`),
  mitte 24%. KMKR loeb mainimiseks ainult numbriga (tühi mallisilt "KMKR: [Kliendi KMKR]" ei loe). Kui tarnija on äriregistri järgi KM-kohustuslane, tuleb hoiatus (`registryVatWarning`), määr jääb dokumendi järgi.
- Mitu KM-määra (nt kunstiteos KM-ta + haamritasu 24%): rea määr rea enda andmetest, vastu võetakse ainult siis, kui read
  annavad kokku dokumendi suurima summa; muidu tavaline tee. Tabel "hind kogus ühik KM% summa(KM-ga)": read KM-ga
  summadest (`findGrossRows`), määr rea %-st, hind × kogus ka OCR-i kaotatud komaga ("4500 400" = 45,00 × 4,00).
  Fixture: `test/fixtures/ocr/vidinad-ekraan.txt`. Päises "KM%" veerg -> paljas arv rea summa ees on rea määr
  ("4h 9 40,00"); vahesumma rea lõpus ("… Kokku km-ta 20,00") pole arverida. Fixture: `test/fixtures/ocr/isolta-naidis.txt`.
- Kogusumma sildi tugevuse järgi (`grossByLabel`): tasumiseks/kokku tasuda > arve summa > kokku; "Kokku km-ta",
  "Käibemaks kokku" pole kogusumma. Ristkontroll: dokumendi "summa km-ta" ja "käibemaks" (suurim või vahesummade summa)
  peavad klappima arvutatuga, muidu hoiatus (vale rea KM-määr jääb nii silma).
- Ostja märge `Party.buyer` ("Arve Klient OÜ-le", "Arve saaja:", "Klient:", "Ostja") – ostjat ei pakuta kunagi tarnijaks.
  Jaluse veergudest liidetud real nimi `nameInColumns`. Kehtetu kuupäev (OCR "00.00.2017") = "".
- Summad ilma senditeta sobivad ainult valuutamärgiga ("3 000 €"). Kuupäev ka sõnadega ("oktoober 23, 2026", "23. oktoober 2026").
  Tähtaja puudumisel kuupäev + 14 päeva.
- Registrikoodi silt on paindlik (`REG_LABEL`: reg.kood, reg,number, Reg no, Reg:, Äriregistri nr, Company code, R/K …), number ka tühikutega või järgmisel real.
- pdf-parse annab paremale joondatud sildi tabulaatoriga väärtuse järel ("11340532⇥Reg.nr.:") ja rea numbrid enne
  kirjeldust – parser pöörab need ümber. Siltidest lahus kuupäevad: tähtaja sildi korral varaseim = arve, hiliseim = tähtaeg.
- Reg.koodi olemasolul võetakse tarnija ametlik nimi ja KMKR äriregistrist (OCR-i vead nimes ei loe).
- Välismaa tarnija (nt Atlassian, "VAT Number: EU372001951", Pty Ltd/GmbH/Inc …): **registrikood ei ole KMKR/VAT-number**
  (kasutaja nõue; `invoiceIssues` keelab). Koduriigi registrinumber sildi järgi (`foreignRegOf`: R.C.S., Company No, ABN,
  HRB, KvK, Org.nr, Y-tunnus …), muidu sisestab kasutaja; pärast saatmist jääb tarnija meelde (VAT järgi ära tuntav).
  Välismaa VAT-iga tarnijat eesti äriregistrist ei otsita. Billberry/XSD nõuavad `sellerRegnumber`-it.
  Valuuta ISO koodist (USD), PayPal/"amount paid" = makstud. Fixture: `test/fixtures/pdf-text/atlassian.txt`.
- Kaks valuutat (AWS: summad USD, KM lisaks EUR): arve valuuta = märk kõige rohkemate summade kõrval (`docCurrency`),
  teise valuuta summad eemaldatakse enne summade/ridade otsingut (`withoutOtherCurrency`). e-arve 1.2-s kursi välja pole →
  KM eurodes + kurss hoiatusse. Fixture: `test/fixtures/pdf-text/aws.txt`.
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
