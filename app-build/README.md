# Voter search app (many villages) — setup, admin and updates

Online-only app at **raj-voter.vercel.app**. Every village has its own address: `raj-voter.vercel.app/<village>`
(e.g. `/adsar`). The voter lists stay on the server, encrypted (`voter-search-app/api/_data/<village>.enc`); phones
only receive the cards that match a search. Every search checks that the user's password is still active.

| Address | What it is |
|---|---|
| `/` | login; then the villages that password opens (a person with one village goes straight to it) |
| `/<village>` | search for that village (login needed) |
| `/<village>/admin` or `/admin` | admin page |

## Who can do what
- **Superadmin** — the `ADMIN_PASSWORD` set in Vercel. Opens every village. Creates **village admins** and chooses
  which villages each one looks after (can change this later with **गाँव बदलें**). Can also add and manage users anywhere.
- **Village admin** — created by the superadmin. Searches only their villages and adds/manages users only there.
  Cannot see or create other admins.
- **User** — belongs to exactly one village; their password only opens that village. Opening another village's
  page with it shows "यह पासवर्ड … का है" with a link to the right village. Besides searching by name, a user can do
  only what their admin ticks under their name on the admin page (the server checks this on every request):
  - **निशान लगा सकते हैं** — set marks on slips
  - **पूरा वार्ड देख सकते हैं** — list a whole ward with no name typed
  - **वार्ड की सभी पर्चियाँ** — print / save a whole ward's slips
  - **पर्ची प्रिंट** — the प्रिंट / PDF button on a slip

  New users (and users added before these boxes existed) start with only **पर्ची प्रिंट**. A change reaches the
  person's phone on their next search, or within a minute. Admins and the superadmin can always do everything.

To add a user the admin must pick the **village** from the dropdown (only their own villages are listed).

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
{ "name": "आडसर", "title": "ग्राम पंचायत आडसर", "ps": 3, "zp": 35, "pollTime": "मतदान समय : प्रातः 7 से सायं 5 बजे तक" }
```
`ps` / `zp` are the पंचायत समिति / जिला परिषद निर्वाचन क्षेत्र numbers printed on the slips. Folder names must be
lower-case English letters, digits and `-` (e.g. `bigga-bas`).

## Adding a village
1. Make a folder (e.g. `bigga/`), put the original PDFs in it, and ask Claude in chat to analyse them
   (see `CLAUDE.md`). That gives the per-ward Excel files, `<VILLAGE>-All Wards.xlsx` and `village.json`.
2. `.venv/bin/python app-build/xlsx_to_json.py bigga` → `bigga/voters.json`
3. `node app-build/encrypt.mjs` → builds every village into the app
4. `git add -A && git commit -m "Add Bigga" && git push` → Vercel redeploys; `raj-voter.vercel.app/bigga` is live.
5. In the admin page, give the village to a village admin (or create one) and add its users.

## One-time Vercel setup
1. **Import the repo** in Vercel: Add New → Project → pick the repo. Project name `raj-voter`.
   Root Directory: `voter-search-app` · Framework Preset: **Other** · Build Command: empty.
2. **Connect a database.** The free Upstash database can be shared with the older Adsar app: Vercel → **Storage** →
   open the existing Upstash database → **Connect Project** → pick `raj-voter` (all environments). This adds
   `KV_REST_API_URL` and `KV_REST_API_TOKEN` (possibly with a prefix; both forms work). This app stores all its
   keys under `rv:` (change with an optional `KEY_PREFIX` variable), so it never touches the other app's passwords.
   With no database yet: Storage → Create Database → **Upstash for Redis** (free plan) → Connect to the project.
3. **Add two environment variables** (Project → Settings → Environment Variables):
   - `DATA_KEY` = the text in `app-build/DATA_KEY.txt`
   - `ADMIN_PASSWORD` = the superadmin password (long, not shared with anyone)
4. **Redeploy** (Deployments → ⋯ → Redeploy) so the variables take effect.

## Admin page
Log in with the superadmin password or a village admin's password (or log into a village with it and press **एडमिन**).
- **नया व्यक्ति जोड़ें:** choose the village, type the person's name → you get their password once → Copy or send by
  WhatsApp (the message has that village's link). The same box has the person's permission ticks (they start with only
  पर्ची प्रिंट), so you can set what they may do right away.
- **नया एडमिन जोड़ें** (superadmin only): name + tick the villages → the admin's password, sent with the `/admin` link.
- **बंद करें:** that password stops working; the person is logged out on their next search.
- **नया पासवर्ड:** new password for the same person (e.g. they forgot it); the old one stops working.
- **लॉग आउट करें:** ends the person's current session; they can log in again with the same password.

## Search page
- **Search** by name or father/husband name (Hindi or English), box number with a ward chosen, `3/25` (ward 3, box 25)
  or Voter ID. Choosing only a ward lists the whole ward in box order, 10 at a time (people allowed to).
- **Filter by mark** (once a ward is chosen): सभी, सिर्फ़ बिना निशान वाले, पूरा हुआ, आ रहे हैं, उपलब्ध नहीं. Marking slips
  while going through the unmarked list doesn't skip anyone on the next page.
- **परिवार** on a slip opens everyone else at the same house number in that ward, as full slips.
- **अ+** (top right) makes the slips and search boxes bigger; the phone remembers it.

## Slips and voter marks
- **प्रिंट / PDF** on a slip: prints that one slip in the top-left corner of an A4 page. To download instead, choose
  **Save as PDF** in the phone's print screen (iPhone: Print → share → Save to Files).
- **वार्ड N की सभी पर्चियाँ** (after choosing a ward): every voter of that ward in box order, two slips per row (about
  10 per A4 page), to print or save as one PDF.
- **Marks**: under each slip, **पूरा हुआ** (green), **आ रहे हैं** (yellow, on the way) or **उपलब्ध नहीं** (red, not
  available). Tapping the lit button again removes it. Every user of the village sees the coloured bar with who set it
  and when (e.g. "आ रहे हैं · Ramesh, 4 नव॰, 10:30 am"); phones showing the slip pick up new marks within a minute (and at
  once when the app is reopened), without searching again. Marks are kept per village in the database (`mark:<village>`).

## Admin page extras
The admin page is split into tabs along the top (they scroll sideways on a phone, and the phone reopens the last one):
**नया व्यक्ति**, **एडमिन** (superadmin only), **सभी पासवर्ड**, **प्रगति**, **मतदाता सूची**, **निशान हटाएं**. A new password
shows above the tabs, whichever tab made it.
- **प्रगति** (वार्ड अनुसार प्रगति): for each of your villages and wards, the total, ✓ पूरा, आ रहे, नहीं and बाकी, with a
  coloured bar and a total row. It refreshes every minute. Tapping a number opens those voters in मतदाता सूची.
- **मतदाता सूची**: pick the village and a ward (or सभी वार्ड), then **पूरा हुआ**, **आ रहे हैं**, **उपलब्ध नहीं** or **बाकी**
  (no mark yet) to list those voters in ward and box order, 100 at a time, with who set the mark and when.
- Each person shows **आज N खोज** (searches today) and how many slips carry their marks; 500 or more searches in a day
  get a yellow badge (a sign the list is being copied).
- **पर्चियों के निशान हटाएं**: pick the village, then remove all marks of one colour, or all of them. After clearing,
  **↺ … निशान वापस लाएं** puts them back; only the most recent clear of each village can be undone.

**One phone at a time:** users and village admins each get one session; opening the same password on a second
phone logs the first one out on its next request. The admin list shows each person's current phone, IP and login
time, and a yellow **एक साथ दो फ़ोन: N बार** count when their password was opened on another phone while the first
was still in use (used in the last 30 minutes): a sign of sharing. The superadmin password can be used on several
devices. Changing `ADMIN_PASSWORD` in Vercel (and redeploying) signs out every superadmin session.

## Phones (Android or iPhone)
Open the village link, enter the password, keep "इस फ़ोन पर याद रखें" ticked. Optional: add to home screen
(Android ⋮ → Add to Home screen, iPhone Share → Add to Home Screen); it opens that village. Needs internet every time.

## Updating voter data
```
node app-build/encrypt.mjs        # re-encrypts every village with the same DATA_KEY
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
