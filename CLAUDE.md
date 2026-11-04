# raj-voter — voter search for many villages

Deployed at raj-voter.vercel.app (Vercel root: `voter-search-app/`). Each village is searched at `/<village>`.
Full setup and admin guide: `app-build/README.md`.

## Layout
- `<village>/` (top level, lower-case English slug = web address): original PDFs, analysed Excel, `village.json`,
  `voters.json`. Everything in these folders stays out of git (see `.gitignore`); only the encrypted build is committed.
- `app-build/encrypt.mjs` builds every village folder that has `village.json` + `voters.json` into
  `voter-search-app/api/_data/<village>.enc` and `voter-search-app/api/_villages.json`.
- `app-build/xlsx_to_json.py <village>` turns `<village>/*All Wards.xlsx` into `<village>/voters.json`
  (run with `.venv/bin/python`).
- Roles: superadmin (`ADMIN_PASSWORD`), village admins (role `admin`, `villages` list), users (one `village`).
  Permission checks live in `voter-search-app/api/_lib.js` (`whoIs`) and `api/admin.js`.

## "Analyse <village>" — turning the PDFs into data
When asked to analyse a village's PDFs (State Election Commission Rajasthan "पंचायत चुनाव निर्वाचक नामावली",
one PDF per ward, e.g. `ADSAR-Ward No-001.pdf`), produce in that village's folder, matching `adsar/` exactly.

### Ward PDF cover page (page 1)
Read page 1 of **every** ward PDF first (from the page image; its text layer may be garbled like the names). It holds:

| Cover page field | Example (Dalman, ward 7) | Used for |
|---|---|---|
| जिलापरिषद का नाम | चुरू | `village.json` → `district` |
| जि॰ प॰ सदस्य निर्वाचन क्षेत्र | 6 | `village.json` → `zp` (जि.प. on the slip) |
| पंचायत समिति का नाम | सरदारशहर | `village.json` → `panchayatSamiti` |
| पं॰ स॰ सदस्य निर्वाचन क्षेत्र | 12 | `village.json` → `ps` (पं.सं. on the slip) |
| ग्रामपंचायत | डालमाण | `village.json` → `name`; folder name = its English spelling (`dalman`) |
| वार्ड क्रमांक | 7 | `Ward` column; must match the file name's ward number |
| विधानसभा क्षेत्र की संख्या एवं नाम | 21-सरदारशहर | `village.json` → `assembly` |
| मुख्य गांव / तहसील / जिला | डालमाण / सरदारशहर / चुरू | `village.json` → `tehsil` (and a check on the rest) |
| पुनरीक्षण का विवरण | वर्ष 2026, गहन पुनरीक्षण, अर्हता दिनांक 01-01-2026, अंतिम प्रकाशन 25-02-2026 | `village.json` → `listDate` (अंतिम प्रकाशन) |
| वार्ड का परिसीमन के अनुसार विवरण | मकान संख्या 266 मोहन राम … से उत्तरी मोहल्ला | not used (ward boundary text) |
| मतदान बूथ की संख्या एवं पता | 73 - राजकीय उच्च माध्यमिक विद्यालय डालमाण ( दांया भाग) | `Matdan Kendra` for every voter of that ward |

- **Matdan Kendra** is written `<booth no>-<booth address>`, no spaces around the first `-` and tidy brackets:
  `73-राजकीय उच्च माध्यमिक विद्यालय डालमाण (दांया भाग)`. The slip splits it at the first `-` into भाग सं. and the
  polling station name. Different wards often share a booth; copy each ward's own cover page.
- The district, पंचायत समिति, ग्रामपंचायत, ps and zp should be the **same on every ward's cover page**. The app keeps
  one ps / zp per village, so if any ward differs, stop and tell the user which wards and what values.
- If a cover page is missing or a field is blank, ask instead of guessing.

### Files to produce
1. **One Excel per ward** `<VILLAGE>-Ward No-NNN.xlsx` and **`<VILLAGE>-All Wards.xlsx`** with two sheets:
   - `All Wards`: `Box Number | Voter ID | Name | Relative Name | Relation | House | Age | Gender | Ward | Matdan Kendra |
     Deleted` — Deleted is empty, or the main-list voter's mark from the deletion supplement (E death, S shifted,
     R repeated). Deleted voters stay in the files in box order; the app shows them greyed, tagged "सूची से हटाया गया",
     and leaves them out of counts, progress, marks and ward slips.
     — Name / Relative Name in English (Roman) spelling, Relation as printed (`पिता` / `पति` / `माता` …),
     Gender as printed (`पुरुष` / `स्त्री`), Ward and Matdan Kendra from that ward's cover page (see above).
   - `Hindi Check`: `Ward | Box Number | नाम (हिंदी) | पिता/माता/पति का नाम (हिंदी) | Name | Relative Name | PDF Page`.
2. **`village.json`** from the cover page. The app uses `name`, `title`, `ps`, `zp`, `pollTime`, and `panchayatSamiti` + `district`
   (shown in the village list); the rest are kept for reference:
   ```json
   { "name": "डालमाण", "title": "ग्राम पंचायत डालमाण", "ps": 12, "zp": 6,
     "pollTime": "मतदान समय : प्रातः 7 से सायं 5 बजे तक",
     "district": "चुरू", "panchayatSamiti": "सरदारशहर", "tehsil": "सरदारशहर", "assembly": "21-सरदारशहर",
     "listDate": "25-02-2026" }
   ```
   The polling time is not on the cover page; use the value above unless the user gives another.
3. Then run `xlsx_to_json.py <village>` and `node app-build/encrypt.mjs`, and report per ward: voter count, booth
   (Matdan Kendra), and anything that needed a guess or a check.

### What a ward PDF contains
- Page 1 cover (above), page 2 ward map, then the **main list** (cards in boxes of 3 per row, grouped under mohalla
  headings such as "जाटों का बास,डालमाण"), then the **पूरक** (supplement): घटक 1 परिवर्धन सूची (additions, numbered
  after the main list, usually without a Voter ID), घटक 2 विलोपन सूची (deletions: the main-list box number with a mark
  E = death, S = shifted, R = repetition; those main cards are also stamped DELETED), घटक 3 संशोधन सूची (corrections:
  a main-list box number with the corrected details), and a last summary page.
- **Final roll per ward = main list − deleted boxes, with corrections applied, + additions** (the deleted ones are
  still listed, tagged). It must equal the cover's
  पुरुष / स्त्री / कुल counts exactly; the cover's अंतिम क्रम संख्या = last addition's box number.
- The text layer is exact for box numbers, Voter IDs, house, age, gender, relation and the section headings, but the
  Hindi names come out without most vowel signs (मांगी लाल → मरपगल लरल, ू often as ब, े as क, ी as ल, ड as र), so
  names are read from page images and checked against those letters. Copy names exactly as printed, odd spellings
  included; a few cards print broken glyphs (dotted circles, missing-glyph boxes) — pick the nearest reading and
  list those cards for the user.

### Tools (app-build/analyse/)
PDF parsing needs PyMuPDF: `.venv/bin/pip install pymupdf` (in the sandbox: a scratch venv and
`pip install --use-deprecated=legacy-certs --cert /etc/ssl/cert.pem pymupdf`). Work folder `<village>/analysis/`
keeps the expensive part (names) so the village can be rebuilt; images and cards.json can be regenerated.
1. `python app-build/analyse/parse_pdfs.py <village> <village>/analysis` → `cards.json`, one image per card page
   (`img/w<ward>_pNN.png`) and `img/w<ward>_manifest.json` (the cards on each page, in order, with the PDF letters).
   It prints each ward's booth, ps, zp, cover total and card counts per section; check that ps/zp agree.
2. Read the names from the images into `names/w<ward>.json`:
   `[{"page", "box", "section", "hname", "hrel", "name", "relname"}]` for every main card (deleted E/S/R ones too: they
   are kept and shown tagged; only a `#` card, replaced by its correction, is skipped), addition and correction.
   One subagent per ward works well (≈15 pages each). `node app-build/analyse/check_names.js <work> <ward>` flags
   missing entries and names that don't fit the PDF letters; every CHECK line must be re-looked at on the image.
3. Write `<work>/booths.json` (`{"72": "72-…"}` from the cover pages), then
   `.venv/bin/python app-build/analyse/build_xlsx.py <village> <work> <PREFIX>` → the Excel files, with a per-ward
   check against the cover totals (every ward must say OK).

## Checks after changes
- `node app-build/encrypt.mjs` must list every village with the expected voter counts.
- Local test: `ADMIN_PASSWORD=admin-test node app-build/dev-server.mjs` → http://127.0.0.1:8765/<village>
  (the in-memory database is wiped on restart).
