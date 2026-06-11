# REID'S PARTY — setup & operations

The site is static (GitHub Pages). The "database" is a private Google Sheet in
your Drive, fed by a tiny Google Apps Script web app. Total cost: $0
(+ optional domain).

```
applicant's phone ──► index.html (GitHub Pages / your domain)
                         │  POST application + ID photo
                         ▼
                  Apps Script /exec  (runs as YOU)
                         │
          ┌──────────────┼─────────────────┐
          ▼              ▼                 ▼
   Google Sheet    Drive folder      email to you
  (all answers)   (ID + images,     per application
   private        private)
          ▲
          │  passcode-gated JSON
          ▼
     admin.html  (status buttons: PENDING / ACCEPTED / WAITLIST / REJECTED)
```

## 1. The one thing only you can do (~3 minutes)

1. Open **https://script.new** (logged in as reidolson35@gmail.com).
2. Delete the placeholder, paste in **`apps-script/Code.local.gs`**
   (it's `Code.gs` with your passcode already filled in — passcode also lives
   in `token.txt`; both are gitignored, never pushed).
3. **Deploy → New deployment → ⚙ type: Web app**
   - Description: anything
   - Execute as: **Me**
   - Who has access: **Anyone**  ← required so applicants can submit
4. Click **Authorize** and accept (it asks for Sheets/Drive/Mail because the
   script creates your sheet, stores uploads, and emails you).
5. Copy the **Web app URL** (ends in `/exec`).
6. Paste it into `config.js` → `ENDPOINT: "https://script.google.com/macros/s/…/exec"`,
   then push (`git add config.js && git commit -m "wire endpoint" && git push`)
   — or just give the URL to Claude and it's handled.

First submission auto-creates, in your Drive, visible only to you:
- Sheet **"Reid's Party Applications"** — one row per applicant
- Folder **"Reid's Party Uploads"** — ID photos + images

## 2. Reviewing applications

- **Phone-native:** Google Sheets app → "Reid's Party Applications".
- **The cockpit:** `admin.html` on the live site → enter passcode (saved on
  the device until you hit LOCK). Cards per applicant, newest first, with
  filter tabs, search, ID thumbnails, tap-to-call/email, and a status dropdown
  that writes straight back to the sheet.
  - ID thumbnails render when that browser is logged into your Google account
    (files are private in your Drive); otherwise tap through to Drive.
- **Push:** every application emails you (subject: `Party application №…`).
  Set `NOTIFY_EMAIL = false` in the script to turn off.

## 3. Domain

Buy **reids.party** (Porkbun or Cloudflare, ~$10–20/yr), then:

1. Repo → Settings → Pages → Custom domain → `reids.party` (creates CNAME file).
2. At the registrar, add DNS records:
   - `A` records for apex `reids.party` → `185.199.108.153`, `185.199.109.153`,
     `185.199.110.153`, `185.199.111.153`
   - `CNAME` for `www` → `reidolson35-netizen.github.io`
3. Back in Pages settings: tick **Enforce HTTPS** once the cert is issued.

## 4. Local demo / development

```bash
python3 mock_server.py     # → http://localhost:8765 (admin passcode in token.txt)
```

Same API as the real backend; submissions land in `responses.json` + `uploads/`
(gitignored). The pages auto-target the mock when opened via localhost.

## 5. Changing things

- **Questions:** edit the `QUESTIONS` array near the top of the script in
  `index.html` (label/helper/required/type). Add a matching column in
  `Code.gs` only if you add a brand-new field id.
- **Passcode:** change `TOKEN` in the Apps Script (Deploy → Manage deployments
  → edit → Version: New), update `token.txt`, re-enter on devices.
- **Statuses:** `STATUSES` in `admin.html` + `allowed` in `Code.gs`.

## 6. Privacy notes

- Responses, ID photos, and images live only in your Google account.
- The public repo contains code only — no passcode, no data (`.gitignore`
  covers `token.txt`, `Code.local.gs`, `responses.json`, `uploads/`).
- IDs are sensitive: when the party's done, consider deleting the
  "Reid's Party Uploads" folder.
