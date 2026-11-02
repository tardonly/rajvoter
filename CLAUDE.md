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
When asked to analyse a village's PDFs (State Election Commission Rajasthan ward-wise voter lists, one PDF per ward,
e.g. `ADSAR-Ward No-001.pdf`), produce in that village's folder, matching `adsar/` exactly:

1. **One Excel per ward** `<VILLAGE>-Ward No-NNN.xlsx` and **`<VILLAGE>-All Wards.xlsx`** with two sheets:
   - `All Wards`: `Box Number | Voter ID | Name | Relative Name | Relation | House | Age | Gender | Ward | Matdan Kendra`
     — Name / Relative Name in English (Roman) spelling, Relation as printed (`पिता` / `पति` / `माता` …),
     Gender as printed (`पुरुष` / `स्त्री`), Matdan Kendra as `<booth no>-<booth name>` from the cover page
     ("मतदान बूथ की संख्या एवं पता"), e.g. `54-राजकीय माध्यमिक विद्यालय, दायां भाग`.
   - `Hindi Check`: `Ward | Box Number | नाम (हिंदी) | पिता/माता/पति का नाम (हिंदी) | Name | Relative Name | PDF Page`.
2. **`village.json`**: `{"name": "<Hindi village name>", "title": "ग्राम पंचायत <name>", "ps": <पंचायत समिति
   निर्वाचन क्षेत्र no>, "zp": <जिला परिषद निर्वाचन क्षेत्र no>, "pollTime": "मतदान समय : प्रातः 7 से सायं 5 बजे तक"}`
   (ps / zp are on the PDF cover page; ask if they are not there).
3. Then run `xlsx_to_json.py <village>` and `node app-build/encrypt.mjs`, and report the voter count per ward.

Notes on reading the PDFs: the text layer gives box number, Voter ID, house, age, gender and relation reliably, but
its Hindi names are garbled (the font drops most vowel signs, e.g. मागी लाल → मरगल लरल), so read the Hindi names
from the page images and check them against the text layer's consonants. Keep every voter, including ones marked
deleted, and check that box numbers per ward run 1..N with no gaps or repeats before building.

## Checks after changes
- `node app-build/encrypt.mjs` must list every village with the expected voter counts.
- Local test: `ADMIN_PASSWORD=admin-test node app-build/dev-server.mjs` → http://127.0.0.1:8765/<village>
  (the in-memory database is wiped on restart).
