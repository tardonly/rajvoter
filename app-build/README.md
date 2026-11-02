# Voter search app (many villages) — setup, admin and updates

Online-only app at **raj-voter.vercel.app**. Every village has its own address: `raj-voter.vercel.app/<village>`
(e.g. `/adsar`). The voter lists stay on the server, encrypted (`voter-search-app/api/_data/<village>.enc`); phones
only receive the cards that match a search. Every search checks that the user's password is still active.

| Address | What it is |
|---|---|
| `/` | list of villages |
| `/<village>` | search for that village (login needed) |
| `/<village>/admin` or `/admin` | admin page |

## Who can do what
- **Superadmin** — the `ADMIN_PASSWORD` set in Vercel. Opens every village. Creates **village admins** and chooses
  which villages each one looks after (can change this later with **गाँव बदलें**). Can also add and manage users anywhere.
- **Village admin** — created by the superadmin. Searches only their villages and adds/manages users only there.
  Cannot see or create other admins.
- **User** — belongs to exactly one village; their password only opens that village. Opening another village's
  page with it shows "यह पासवर्ड … का है" with a link to the right village.

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
2. **Add a database:** Project → Storage → Create Database → **Upstash for Redis** (free plan) → Connect to the project.
   This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.
3. **Add two environment variables** (Project → Settings → Environment Variables):
   - `DATA_KEY` = the text in `app-build/DATA_KEY.txt`
   - `ADMIN_PASSWORD` = the superadmin password (long, not shared with anyone)
4. **Redeploy** (Deployments → ⋯ → Redeploy) so the variables take effect.

## Admin page
Log in with the superadmin password or a village admin's password (or log into a village with it and press **एडमिन**).
- **नया व्यक्ति जोड़ें:** choose the village, type the person's name → you get their password once → Copy or send by
  WhatsApp (the message has that village's link).
- **नया एडमिन जोड़ें** (superadmin only): name + tick the villages → the admin's password, sent with the `/admin` link.
- **बंद करें:** that password stops working; the person is logged out on their next search.
- **नया पासवर्ड:** new password for the same person (e.g. they forgot it); the old one stops working.
- **लॉग आउट करें:** ends the person's current session; they can log in again with the same password.

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
