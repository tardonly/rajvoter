# Voter search app (many villages) — setup, admin and updates

Online-only app at **raj-voter.vercel.app**. Every village has its own address: `raj-voter.vercel.app/<village>`
(e.g. `/adsar`). The voter lists stay on the server, encrypted (`voter-search-app/api/_data/<village>.enc`); phones
only receive the cards that match a search. Every search checks that the user's password is still active.

| Address | What it is |
|---|---|
| `/` | login; then the villages that password opens (a person with one village goes straight to it) |
| `/<village>` | search for that village (login needed) |
| `/admin` | the one admin page: every user of every village the admin looks after (the old `/<village>/admin` redirects here) |

## Who can do what
- **Superadmin** — the `ADMIN_PASSWORD` set in Vercel. Opens every village. Creates **village admins** and chooses
  which villages each one looks after (can change this later with **गाँव बदलें**): villages one by one, or a whole
  पंचायत समिति with **पूरी पंचायत समिति** (kept as the samiti, so villages imported into it later are that admin's at
  once; field `samitis` on the admin's login). Can also add and manage users anywhere.
- **Village admin** — created by the superadmin, or a user made admin with **एडमिन बनाएं** on their card (same number
  and password; becomes admin of their village). Searches only their villages. Cannot see or create other admins. On
  each admin's card (एडमिन tab) the superadmin ticks:
  - **ऐप में** — the same app permissions as a user (below); admins made before this: all of them.
  - **एडमिन पेज पर** (`ADMIN_PERMS` in `api/_lib.js`, field `aperms`): **नए व्यक्ति बना सकते हैं** · **अपने बनाए व्यक्ति
    देख सकते हैं** (and look after them) · **अपने गाँवों के सभी व्यक्ति देख सकते हैं** · **अपने व्यक्तियों को सर्च जोड़
    सकते हैं** · **अपने व्यक्तियों के अनुरोध मंज़ूर कर सकते हैं** (also requests sent to them). New admins: all; a user
    made admin: all but "सभी व्यक्ति"; admins made before this: all.
  - **रोज़ की सर्च सीमा** — empty = no limit (as before); a number limits the admin's searches per day like a user's,
    with **+100 आज के लिए**.
- **User** — belongs to exactly one village; their password only opens that village. Opening another village's
  page with it shows "यह पासवर्ड … का है" with a link to the right village. Besides searching by name, a user can do
  only what their admin ticks under their name on the admin page (the server checks this on every request):
  - **निशान लगा सकते हैं** — set marks on slips
  - **पूरा वार्ड देख सकते हैं** — list a whole ward with no name typed
  - **वार्ड की सभी पर्चियाँ** — print / save a whole ward's slips
  - **पर्ची प्रिंट** — the प्रिंट / PDF button on a slip
  - **वार्ड अनुसार प्रगति देख सकते हैं** — a green **वोटर रिपोर्ट** button at the top of the app (next to where admins
    see **एडमिन**) opens the per-ward table (**↻ रिफ्रेश** reloads it, **✕** closes it): कुल, वोट दिया, आ रहे, वोटर नहीं, बाकी, with a coloured bar per ward. A
    candidate's worker sees only that candidate's marks; others see the village's own marks. Admins always have the
    button and see the village's own marks plus each candidate's. Not in the demo.
  - **मतदाता सूची देख सकते हैं** — a blue **मतदाता सूची** button next to it opens the same list as the admin page's
    मतदाता सूची tab: the voters marked वोट दिया / आ रहे हैं / वोटर नहीं है or still बाकी, all wards or one, with who
    marked them and when, 100 at a time (**और दिखाएं**). A tap on a number in the वोटर रिपोर्ट table opens those
    voters. Same groups as the report: a candidate's worker sees only that candidate's marks; an admin, the village's
    own. Not in the demo.

  New users (and users added before these boxes existed) start with **निशान लगा सकते हैं**, **पर्ची प्रिंट** and
  **वार्ड अनुसार प्रगति देख सकते हैं**. A change reaches the person's phone on their next search, or within a minute.
  A village admin starts with all of them; the superadmin ticks theirs under **ऐप में** (in the new-password box when
  the admin is made, or in the एडमिन tab later). The superadmin can always do everything.
- **Daily search limit (users only):** each user may start 500 searches a day (Indian time), or the number their admin
  types under **रोज़ की सर्च सीमा** (in the new-password box when the person is added, or under their name later; empty =
  500). **+100 आज के लिए** adds 100 for today only. One search is everything from typing a name until the search box is
  cleared: typing more letters or deleting some, adding the father's name, changing the ward or mark filter, the next
  pages and **परिवार** all count once. The server hands out the search id and checks it (same person, the same name
  typed further or shorter, at most 25 requests and 10 minutes), so a phone can't avoid counting. A whole ward listed
  with no name counts once per ward, and a ward's slips count once each time. At the limit the phone shows
  "आज की सर्च सीमा पूरी हो गई"; under 20 left, the count line shows "आज N सर्च बाकी". Anyone (admins too) is also
  held to 60 requests a minute.

To add a user the admin must pick the **village** from the dropdown (only their own villages are listed).

## Demo (for marketing)
`raj-voter.vercel.app/demo` lists every village in the app; picking one opens `/demo/<village>` (e.g. `/demo/riri`; the old `/demo-riri` redirects there): that
village's voter list, **wards 1–2 only**, for anyone, with no password, to try the search. **गाँव बदलें** goes back to the
list. Each phone keeps a random device id and gets **10 searches in all**, across all demo villages (counted the same way
as above, by the server); one internet address
gets at most 30 a day, so clearing the browser doesn't give more. The demo never changes real data: your team's marks
aren't shown, and the वोट दिया / आ रहे हैं / वोटर नहीं है buttons work only on the visitor's phone (kept there, never sent to
the server). No printing, no whole-ward lists; परिवार works. An orange bar shows the searches left and
a box for the visitor's village name that opens a WhatsApp chat with it filled in. A new village shows up in the demo by itself; demo villages can't be given users or candidates.

The start page, the demo's village list and the orange bar have **▶ वीडियो देखें**: a 31-second promo of the app
(`voter-search-app/promo-phone.mp4` upright, `promo-laptop.mp4` wide; made in `demo-video/`, kept out of git apart from
these two files). A phone opens the phone video first, a laptop or computer the laptop one; **📱 फ़ोन / 💻 लैपटॉप** on top
of the video switch between them. Next to it, and on the video itself, **↗ शेयर करें** opens a box to put the upright video
with the site's link (`raj-voter.vercel.app`, never the demo's) on **WhatsApp status** (phones that can share files: pick
WhatsApp, then "My status"; elsewhere the video downloads and the text is copied for the caption), send the link in a
WhatsApp chat, share it to any other app, copy it, or download either video.

## Folder layout (this repo)
```
adsar/                    one folder per village; the folder name is the web address
  village.json            name and slip details (see below)
  *.pdf                   original voter list PDFs        (never in git)
  *.xlsx                  analysed data, per ward + "All Wards" (never in git)
  voters.json             data the app is built from       (never in git)
app-build/                encrypt.mjs, xlsx_to_json.py, dev-server.mjs, DATA_KEY.txt (key never in git)
voter-search-app/         the website + API that Vercel runs
```
`village.json` example:
```json
{ "name": "आडसर", "title": "ग्राम पंचायत आडसर", "ps": 3, "zp": 35, "pollTime": "मतदान समय : प्रातः 7 से सायं 6 बजे तक" }
```
`ps` / `zp` are the पंचायत समिति / जिला परिषद निर्वाचन क्षेत्र numbers printed on the slips. Optional `panchayatSamiti`
and `district` (e.g. `"सरदारशहर"`, `"चुरू"`) are shown under the village's name in the अपना गाँव चुनें list. With more than
5 villages (the superadmin's list, the demo) that list gets a **गाँव सर्च करें** box (Hindi or English, spelling need not be
exact: "kitsar" finds कितासर) and a **पंचायत समिति** filter, which the phone remembers. Folder names must be
lower-case English letters, digits and `-` (e.g. `bigga-bas`).

## Adding a village
1. Make a folder (e.g. `bigga/`), put the original PDFs in it, and ask Claude in chat to analyse them
   (see `CLAUDE.md`). That gives the per-ward Excel files, `<VILLAGE>-All Wards.xlsx` and `village.json`.
2. `.venv/bin/python app-build/xlsx_to_json.py bigga` → `bigga/voters.json`
3. `node app-build/encrypt.mjs` → builds every village into the app
4. `git add -A && git commit -m "Add Bigga" && git push` → Vercel redeploys; `raj-voter.vercel.app/bigga` is live.
5. In the admin page, give the village to a village admin (or create one) and add its users.

### From another team's JSON files (no PDFs needed)
Voter lists already converted by another team come as one folder per district / पंचायत समिति / gram panchayat, each
holding a few versions of that village's `.json.gz` (e.g. `rajasthan/bikaner/lunkaransar/kaloo/*.json.gz`). One command
turns all of it into village folders and builds the app data:
```
node app-build/import_json.mjs rajasthan --dry-run     # see what it would do (nothing written)
node app-build/import_json.mjs rajasthan               # write the village folders, then run encrypt.mjs
```
(`rajasthan` = the folder copied into this project; it stays out of git. Any part of it works too, e.g.
`rajasthan/bikaner`.) From the S3 bucket instead: `node app-build/import_json.mjs --bucket <bucket name>` downloads
everything under `rolls/` into `import/` first (only changed files on a rerun; `--bucket <name> rolls/bikaner` for one
district). Then commit and push.

It prints only what may need a look (lines starting `!`), then per district · पंचायत समिति how many villages are new,
got wards added, were unchanged or skipped, and the voters. Every village's line is in `import-report.txt`. Rerunning
is safe: unchanged villages are not rewritten (`encrypt.mjs` also leaves their `.enc` file as it is, so git shows only
real changes). `--no-build` skips the encrypt step. The newest version of each village is used (of two made at the same
time, the one with more in it); unreadable files are listed and skipped.

**Size limit:** the encrypted voter data is bundled into the search functions, and Vercel allows 250 MB per function.
Compressed, a village takes about 70 KB (145 villages = 10 MB), so roughly 3,000 villages fit; `encrypt.mjs` warns
above 200 MB. All of Rajasthan (about 11,000 gram panchayats) does not fit: that needs the data moved out of the
deployment (e.g. to S3) first.

- A village goes to our folder with the same Hindi name and पंचायत समिति (their `ridi` → our `riri`, `baijasar` →
  `baijasar-rajalwara`, `bigga-bass-ramsara` → `bigga-ramsara`), else to the last part of `panchayat` (`…/adsar` →
  `adsar/`); if that folder holds a village of another samiti, the samiti is added (`bigga-lunkaransar/`). A village we
  don't have yet gets a new folder with `voters.json` and a `village.json` (name, ps/zp, district, पंचायत समिति from
  their `tehsil`, which holds the samiti's name). If `<village>-<samiti>` is taken too, `<village>-<samiti>-<district>`.
- **Wards we analysed ourselves** (folders with `* All Wards.xlsx`) are the source of the English names. Villages whose
  election is over are moved out of the app into `election-done/` in the main checkout; add
  `--names ../../../election-done` (or its full path) so their names still teach the import, else the names are only
  spelled out from the Hindi (the report then says `English names: 0%`).
- **पं.सं. / जि.प. per ward**: in about 25 villages some wards belong to another पंचायत समिति / जिला परिषद
  constituency (e.g. बामनवाली wards 1–4 पं.सं. 1, wards 5–11 पं.सं. 4). The import keeps each ward's numbers in
  `voters.json` (`seats`), `encrypt.mjs` puts the wards that differ from `village.json` into `_villages.json`, and each
  slip prints its own ward's numbers. Our own wards use the cover pages (`village.json`); where their file disagrees
  the import prints a CHECK line (only अमरसर: they say 7, the cover pages of wards 1–2 say 2).
- **Wards we analysed ourselves are kept as they are**; only the missing wards are added from their file (the
  `imported` list in `voters.json` remembers which). A rerun with a newer file replaces only those. If their Voter IDs
  don't match ours at the same ward + box, the village is skipped. With several files for one village, the newest
  (`generated`) is used.
- Their files have no English names. These are made from the Hindi, word by word from the names in our own villages
  (Adsar test: 97% the same as the names typed from the PDFs, the rest one or two letters off, which search allows).
  Common slips in their Hindi are fixed (सिह → सिंह, ॅ → ँ, ॉ → ाँ). Their struck-off voters have no reason, so the
  slip says only "सूची से हटाया गया" (`del` = `X`); voters marked R (repeated) are missing from their files.
- Not taken over (yet): their caste, family and parent links.

## One-time Vercel setup
1. **Import the repo** in Vercel: Add New → Project → pick the repo. Project name `raj-voter`.
   Root Directory: `voter-search-app` · Framework Preset: **Other** · Build Command: empty.
2. **Connect a database.** The free Upstash database can be shared with the older Adsar app: Vercel → **Storage** →
   open the existing Upstash database → **Connect Project** → pick `raj-voter` (all environments). This adds
   `KV_REST_API_URL` and `KV_REST_API_TOKEN` (possibly with a prefix; both forms work). This app stores all its
   keys under `rv:` (change with an optional `KEY_PREFIX` variable), so it never touches the other app's passwords.
   With no database yet: Storage → Create Database → **Upstash for Redis** (free plan) → Connect to the project.
   **People's data in your own Redis (outside Vercel):** set `USER_REDIS_URL` = `redis://user:password@host:port`
   (`rediss://` for TLS; an Upstash REST `https://…` address also works, with `USER_REDIS_TOKEN`). Then the logins
   (names, mobile numbers, passwords, sessions), bought searches, pack requests, payments and OTP codes are kept there
   (`USER_KEYS` in `api/_lib.js`), through the `ioredis` package (`package.json`; Vercel installs it), and Upstash keeps
   the rest: slip marks, candidates, search counters, rate limits, demo counts. Moving over: after the deploy, log in
   to the admin page as superadmin and press **लोगों का डेटा नए डेटाबेस में ले जाएं** once — until then people from
   before can't log in. It copies those keys into the new database (never overwriting what is already there) and then
   removes them from Upstash; pressing it again is safe. Local test: `DEV_USER_REDIS=1` on `dev-server.mjs` (a second
   in-memory store on PORT + 1 stands in for it).
3. **Add two environment variables** (Project → Settings → Environment Variables):
   - `DATA_KEY` = the text in `app-build/DATA_KEY.txt`
   - `ADMIN_PASSWORD` = the superadmin password (long, not shared with anyone)
   - optional, for UPI payment in the app: `JADUPE_TOKEN` = the API token from jadupe.com → APIs and Documentation (the
     part after `Bearer `). Without it the app offers only WhatsApp to the admin. On JaduPe set the webhook URL to
     `https://raj-voter.vercel.app/api/pay`.
4. **Redeploy** (Deployments → ⋯ → Redeploy) so the variables take effect.

## Signing up with a mobile number, and getting more searches
The login page asks only for the **mobile number** first:
- A number that already has a login for that village (or, on the start page, any login) gets the password box. With
  OTP set up (below) it also has **पासवर्ड भूल गए? OTP से नया बनाएं**: a code to the number, then a new password, and
  the app opens; without OTP it says "पासवर्ड याद नहीं? अपने एडमिन से पूछें". Admins without a number use
  **एडमिन? सीधे पासवर्ड से खोलें** (made-up passwords only).
- A new number types a name and **chooses its own password** (6–40 characters; on the start page it also picks the
  village) and gets its **own login at once** (`api/signup.js`), then goes straight into the village. A password
  someone chose is kept with their number (`ownPwHash` in `api/_lib.js`), so it opens only with that number — also on
  the admin page, which has a mobile number box for it. In the app, **🔑** (पासवर्ड बदलें) lets anyone with a number
  choose a new password; an admin's **नया पासवर्ड** still makes up one. Free searches
  for such a sign-up follow the superadmin's rule, set on the admin page (**साइन-अप पर मुफ़्त सर्च**, `freeRule` in
  `api/_lib.js`), counted per village (retired logins too): **सीधे** — the first X people of each village get Y each,
  later ones none; **घटते हुए** — the first X get Y, the next X get Y/2, and so on down to 1, then none (10 → 5 → 2 → 1).
  Until it is set: सीधे, 10 people, 10 searches. A number that signed up before (in any village) gets no
  free searches again. One internet address can sign up 3 times a day.
- **OTP for a forgotten password (optional):** with `OTP_SEND_URL` set in Vercel, a number with a login can get a 6-digit
  code to set a new password (sign-up itself sends none). Codes last 10 minutes; a new one after 30 seconds, 5 a day per
  number, 5 wrong tries per code (`OTP` in `api/_lib.js`). With **2Factor** (2factor.in, API key under the dashboard's
  API section): `OTP_SEND_URL` = `https://2factor.in/API/V1/<API key>/SMS/{mobile}/{otp}/<OTP template name>` (the
  template name as approved in 2Factor's DLT section; a voice call instead: `…/VOICE/{mobile}/{otp}`, no DLT needed).
  Any other provider: its send address with `{mobile}` (10 digits), `{mobile91}` and `{otp}` in it; for a POST API also
  `OTP_SEND_METHOD=POST` and `OTP_SEND_BODY` (same placeholders). Without `OTP_SEND_URL` there is no reset by OTP. Local test: `DEV_OTP=1` on `dev-server.mjs`
  (the code is at `/__otp/last?mobile=<number>`).
- Picked the wrong village? The new-password window has **गलत गाँव? बदलें**, and in the app a signed-up login has a
  **गाँव बदलें** button: पंचायत समिति, then village. The login moves itself there with its password and searches and
  stays logged in (`api/signup.js` "move"). It can do this **3 times** (`MOVES` in `api/_lib.js`); after that the
  admin moves it (admin page, **गाँव:**).
- Signed-up logins have no daily limit: their searches (free + paid) never run out by date. When none are left, the
  **🛒 और सर्च** window opens by itself (after logging in, or on the next search); the **🛒 और सर्च खरीदें** button opens
  it any time.
- Logins made by an admin can buy searches too: they keep their daily limit, and the bought searches are used only
  once the day's are used up (counted for good under `paid:<id>`, like a sign-up's). The app shows **🛒 और सर्च
  खरीदें** to them as well, opens the window when the day's searches and bought ones are both used up, and the count
  line says e.g. "आज की सर्च पूरी · खरीदी 297 सर्च बाकी". On the admin page they get both the limit box and **सर्च जोड़ें**,
  a "₹ खरीदी · N सर्च बाकी" badge, and the bought searches used beside today's.

More searches: the **🛒 और सर्च खरीदें** window offers packs (`PACKS` in `index.html`, `admin.html` and `api/_lib.js`;
the ₹1-a-search price is shown struck through beside the pack price, with the saving): 100 searches
₹100, 200 ₹200, 500 ₹400, 800 ₹650, 1000 ₹800. The person picks one, pays the admin, and the **💬 WhatsApp** button
opens a chat with that person's admin: whoever made the login (the superadmin, or a village admin who is still active,
has a number and looks after the village), else — for a self sign-up — the village's admin with the fewest villages,
using the mobile number on the admin's login (so give every village admin a number); with no such admin, the
superadmin, i.e. the app's number (`WHATSAPP` in `index.html`). The request is kept as sent to that admin (`to`), and
only that admin sees it under 🔔 (the superadmin sees all, with "भेजा: <name>"); the window closes once WhatsApp opens. The message has the person's name,
mobile number, village, the pack and a link `/<request id>` (8 digits): the request is made only when that button is
tapped (picking a pack makes none) and kept on the server
(`req:<id>`, `api/signup.js` "request"; asking for the same pack again sends the same request) and the link itself
shows nothing about the person. Opening it shows the admin login (only an admin password gets in; a person's own
password is refused), then the **✅ सर्च मंज़ूरी** popup: the person with **📞 कॉल करें** and WhatsApp buttons to follow
up, their searches so far, the pack asked for and what the payment should be. The admin picks or changes the number to
match the payment and taps **✓ भुगतान मिल गया — N सर्च जोड़ें**; a WhatsApp button then tells the person. A request
can be approved once: opening its link later shows "यह अनुरोध मंज़ूर हो चुका है" with how many, by whom and when, and
nothing to do. **✕ अस्वीकार करें** (tap twice) closes a request without searches, e.g. when no payment came; its link then
shows "अस्वीकार किया जा चुका है" and a WhatsApp button can tell the person. An admin of another village gets "not in your list" (the server checks too). Older messages with
`/admin#add=<mobile>&n=<searches>&v=<village>` still open the same popup.
The **🔔** button at the top of the admin page shows how many requests are waiting (red number, refreshed every
minute) and lists the admin's requests: waiting ones first, then those approved (with the ₹ collected and which admin collected
it) or rejected in the last 30 days; tapping one opens the approval popup; **↻** in the popup fetches them again. A village admin sees only requests made
from their own villages by people of those villages; the superadmin sees all. Every approval records the payment
(the pack's price, else ₹1 a search); searches added by hand with **सर्च जोड़ें** are recorded too, as "हाथ से जोड़ी".
The superadmin also sees **💰 कुल वसूली**: the total collected, and per admin the ₹, number of payments and searches
(all time, `pay:*` keys); a village admin sees **💰 आपकी वसूली**, only what they collected themself.
**हिसाब (ledger):** a tap on an admin's row (a village admin: on "📒 हिसाब देखें") lists every payment that admin
collected and every handover to the superadmin, newest first, with वसूली / जमा किया / बाकी. When an admin hands over
the money, the superadmin records it there (₹ and a note such as cash / UPI; a wrong entry can be removed), and the
बाकी (due) goes down; "एडमिन से आना बाकी" on the superadmin's box is the total still due from all admins
(`settle:<admin id>` and `pay:settled` keys). Searches can also be added by hand in
the people list: **सर्च जोड़ें** with the pack sizes or any number. Those logins are tagged "₹ भुगतान किया" and no
longer count for the free sign-up tiers.
Signed-up logins are tagged "बनाया: खुद, मोबाइल नंबर से" and show their searches instead of a daily limit; admin-made
logins show their daily limit and, once they have bought some, their bought searches as well.

**Paying online by UPI (JaduPe):** with `JADUPE_TOKEN` set, the buy window has only **💳 ₹X UPI से अभी भुगतान करें**
instead of the WhatsApp button (`api/pay.js`); if JaduPe refuses (e.g. "Please complete KYC and wait for admin
approval"), the window says so and shows the WhatsApp button after all. It makes a request (gw `jadupe`, sent to the superadmin) and a JaduPe transaction
for the pack's price, and opens JaduPe's payment page, which comes back to `/<village>?pay=<request id>`; the app then
shows whether the payment came and the searches were added. The searches are added by themselves when JaduPe says the
transaction is **completed** for at least the pack's price (within ₹1): checked when the person comes back, when
JaduPe calls the webhook (`/api/pay`), or when the superadmin opens the request. The payment status is always asked
from JaduPe with our token, never taken from the webhook's own data, so a made-up webhook adds nothing. A **timeout** /
**error** closes the request as rejected. The money goes to the superadmin's JaduPe account, so it counts as collected by the superadmin
("UPI ऑनलाइन (JaduPe)" in the ledger) and no admin owes it. Open online requests show only to the superadmin, marked
"💳 UPI ऑनलाइन". JaduPe needs a mobile number: a login without one is sent as `JADUPE_MOBILE` (default 9999999999);
the email sent is `JADUPE_EMAIL` (default noreply@raj-voter.vercel.app).

## Survey and polling-day marks
The slips have two sets of marks, kept apart: **सर्वे** before the election (**अपना वोट** green, **सोच रहे हैं** yellow,
**विपक्ष** red) and **मतदान दिवस** on the day (**वोट दिया**, **आ रहे हैं**, **वोटर नहीं है**). The superadmin switches the whole
app between them in the **पर्ची के निशान** box at the top of the admin page (polling day until first switched). The
buttons, वोटर रिपोर्ट, मतदाता सूची and निशान हटाएं all work on the set in use; switching erases nothing. On polling day
every slip also shows its survey mark as a small tag (सर्वे: अपना वोट), so workers know whom to bring. Kept in
`mark:<village>…` (polling day) and `smark:<village>…` (survey); the switch is the key `markmode`.

## Admin page
Log in with the superadmin password or a village admin's password (or log into a village with it and press **एडमिन**).
- **+ नया व्यक्ति** (व्यक्ति tab): choose the village, type the person's name → you get their password once → Copy or send by
  WhatsApp (the message has that village's link). The same box has the person's permission ticks (they start with
  निशान, पर्ची प्रिंट and वार्ड अनुसार प्रगति), so you can set what they may do right away.
- **नया एडमिन जोड़ें** (superadmin only): name + tick the villages → the admin's password, sent with the `/admin` link.
  The same box has the admin's ticks: in the app, on the admin page, and their daily search limit.
- Each person shows **बनाया: …** (made by): the admin who created that password ("आप" for yourself). Passwords made
  before this tag existed have none.
- **बंद करें:** that password stops working; the person is logged out on their next search.
- **नया पासवर्ड:** new password for the same person (e.g. they forgot it); the old one stops working.
- **लॉग आउट करें:** ends the person's current session; they can log in again with the same password.

## Search page
- **Search** by name or father/husband name (Hindi or English), **house number** (मकान नं., e.g. `445` finds 445, 445 क
  and 445A; `445 क` only that one; choose a ward to narrow it) or Voter ID. The box number is shown on the slip but is
  not searched (people remember their house number, not their box). The search starts once typing pauses (0.6 s) or on Enter, needs at least two letters, and isn't sent
  again when nothing changed. Choosing only a ward lists the whole ward in box order, 10 at a time (people allowed to).
- **Filter by mark** (once a ward is chosen): सभी, सिर्फ़ बिना निशान वाले, वोट दिया, आ रहे हैं, वोटर नहीं है. Marking slips
  while going through the unmarked list doesn't skip anyone on the next page.
- **परिवार** on a slip opens everyone else at the same house number in that ward, as full slips.
- **अ+** (top right) makes the slips and search boxes bigger; the phone remembers it.
- **🌐 English / हिंदी** (top right, also on the login screen and the admin page) switches the whole app's language; the
  phone remembers it. In English the slips show the English spelling of each name first (the Hindi one beside it);
  polling-station addresses and samiti / district names stay as printed (Hindi).
- Voters struck off in the list's supplement (E death, S shifted, R repeated) are still found, shown greyed with
  "✕ सूची से हटाया गया (E – मृत्यु)" and their names crossed out. They can't be marked or printed and aren't counted in
  progress, the mark filters or a ward's slips.

## Slips and voter marks
- **प्रिंट / PDF** on a slip: prints that one slip in the top-left corner of an A4 page. To download instead, choose
  **Save as PDF** in the phone's print screen (iPhone: Print → share → Save to Files).
- **वार्ड N की सभी पर्चियाँ** (after choosing a ward): every voter of that ward in box order, two slips per row (about
  10 per A4 page), to print or save as one PDF.
- **Marks**: under each slip, **वोट दिया** (green), **आ रहे हैं** (yellow, on the way) or **वोटर नहीं है** (red, not a
  voter here). Tapping the lit button again removes it. Every user of the village sees the coloured bar with who set it
  and when (e.g. "आ रहे हैं · Ramesh, 4 नव॰, 10:30 am"); phones showing the slip pick up new marks within a minute (and at
  once when the app is reopened), without searching again. Marks are kept per village in the database (`mark:<village>`).
- **Candidates (उम्मीदवार)**: a candidate is a group of a village's users (usually 3–4 workers). They mark and see only
  their candidate's marks (`mark:<village>:c:<id>`); other candidates' workers never see them, and they don't see the
  village's own marks. Users with no candidate, and admins searching the village, use the village's own marks. A
  worker's top bar shows "उम्मीदवार: <name>".

## Admin page extras
The admin page is split into tabs along the top (they scroll sideways on a phone, and the phone reopens the last one):
**व्यक्ति** (everyone's passwords, with a **+ नया व्यक्ति** button that opens the add form in a popup), **एडमिन**
(superadmin only), **उम्मीदवार**, **प्रगति**, **मतदाता सूची**, **निशान हटाएं**. A new password
shows above the tabs, whichever tab made it.
- **उम्मीदवार**: create a candidate (village + name), add people already made to it (**व्यक्ति चुनें… → जोड़ें**; someone
  in another candidate's group moves over), remove them (✕), or delete the candidate (its marks are deleted, its
  workers go back to the village's marks). The add-person popup and each person's row also have an **उम्मीदवार** choice
  once their village has candidates.
- प्रगति, मतदाता सूची and निशान हटाएं show each group apart once a village has candidates: "रीड़ी · आम निशान" (the
  village's own marks) and "रीड़ी · उम्मीदवार <name>".
- **प्रगति** (वार्ड अनुसार प्रगति): for each of your villages and wards, the total, ✓ वोट दिया, आ रहे, वोटर नहीं and बाकी, with a
  coloured bar and a total row. It refreshes every minute. Tapping a number opens those voters in मतदाता सूची.
- **मतदाता सूची**: pick the village and a ward (or सभी वार्ड), then **वोट दिया**, **आ रहे हैं**, **वोटर नहीं है** or **बाकी**
  (no mark yet) to list those voters in ward and box order, 100 at a time, with who set the mark and when.
- **गाँव:** (when you look after more than one village) moves a person to another village. Their उम्मीदवार is cleared
  (candidates belong to one village) and their phone is logged out; their password then opens the new village, and on
  the old village's page it points there. Their marks stay with the old village.
- Each person shows **आज की सर्च: N / L (P%) · R बाकी** (searches today out of their daily limit, and how many are left)
  over a bar that is green under half the limit, yellow from 50% to 80% and red above 80%, and how many slips carry
  their marks. A person who has used up today's limit also gets a yellow **आज की सर्च सीमा पूरी** badge. The +100 and
  the limit box update the bar straight away.
- **पर्चियों के निशान हटाएं**: pick the village, then remove all marks of one colour, or all of them. After clearing,
  **↺ … निशान वापस लाएं** puts them back; only the most recent clear of each village can be undone.

**One phone at a time:** users and village admins each get one session; opening the same password on a second
phone logs the first one out on its next request. The admin list shows each person's current phone, IP and login
time, and a yellow **एक साथ दो फ़ोन: N बार** count when their password was opened on another phone while the first
was still in use (used in the last 30 minutes): a sign of sharing. The superadmin password can be used on several
devices. Changing `ADMIN_PASSWORD` in Vercel (and redeploying) signs out every superadmin session.

## Phones (Android or iPhone)
Open the village link, enter the password, keep "इस फ़ोन पर याद रखें" ticked. Optional: install it as an app with
**📲 ऐप इंस्टॉल करें** (at the top of every page, and in the footer). Chrome and Edge
(Android, laptops) open their own Install box; elsewhere it shows the steps for that device only, in Hindi (Mac Safari:
File → Add to Dock; Firefox on a laptop can't, so it says to use Chrome or Edge). iPhone and iPad get no button: no page
can ask to be installed there, it is only Share → Add to Home Screen by hand. Every page is its own app (`api/manifest.js`): a village page opens that village, the start page
`/` the start page, `/demo` the demo's list. The buttons hide when the page is opened from the icon. Needs internet every time.

## Updating voter data
```
node app-build/encrypt.mjs        # compresses + encrypts every changed village with the same DATA_KEY
git add -A && git commit -m "Update voter data" && git push
```
If you ever create a new `DATA_KEY.txt`, update the `DATA_KEY` variable in Vercel too. Changing the key makes
all existing passwords stop working (they are tied to it), so add the admins and people again.

## Testing on this Mac
```
ADMIN_PASSWORD=admin-test node app-build/dev-server.mjs     # then open http://127.0.0.1:8765/adsar
```
It imitates Vercel (including the village addresses) and the database in memory (everything added there is lost
when it stops).
