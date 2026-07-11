# REID'S PARTY - setup & operations

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

## 1. Backend status: DEPLOYED ✓ (2026-06-12)

The web app is live and wired into `config.js`. Moving parts:

- **Script**: "Untitled project", scriptId `1SL4lN3ZyemQZzGNQQ1949ESurWiL2bvdugDWxXvfVkrK8qg5YqoeSjks`
  (deployed via `clasp` from `gas/`, deployment
  `AKfycbxMUOmPdK9_pOShAiBm-BmLTY6N7PioBY9VjabLo_coVVX6xvK3CkK47v7VurbhC7tLmQ`)
- **GCP project**: `sunny-dialect-499212-k4` ("My Project 88054") - owns the
  OAuth consent screen (External / Testing, reidolson35@gmail.com is a test
  user) and has the Drive API enabled. Required because this Google account
  hard-blocks unverified-app consent; test users are exempt.
- In your Drive (created on first use, only you can see them):
  Sheet **"Reid's Party Applications"** + folder **"Reid's Party Uploads"**.

**To change backend code later** (token lives in `~/.clasprc.json`):

```bash
cd gas
# edit Code.js (it's the real deployed source, passcode inside, gitignored)
PATH="$HOME/.npm-global/bin:$PATH" clasp push -f
PATH="$HOME/.npm-global/bin:$PATH" clasp redeploy \
  AKfycbxMUOmPdK9_pOShAiBm-BmLTY6N7PioBY9VjabLo_coVVX6xvK3CkK47v7VurbhC7tLmQ
```

Same `/exec` URL survives redeploys - no config.js change needed.
`apps-script/Code.gs` is the public placeholder copy; `gas/Code.js` +
`apps-script/Code.local.gs` are the real ones (gitignored).

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

## 3. Domain: reidsparty.com

Reid owns **reidsparty.com** (2026-06-12). GitHub side is done (CNAME file in
repo + Pages cname set). Registrar DNS records:

- `A` for apex `@` → `185.199.108.153`, `185.199.109.153`,
  `185.199.110.153`, `185.199.111.153`
- `CNAME` for `www` → `reidolson35-netizen.github.io`
- Delete any pre-filled parking/forwarding records. On Cloudflare keep
  records DNS-only (grey cloud) until the certificate is issued.

Once DNS propagates: Pages settings → **Enforce HTTPS** (or
`gh api -X PUT repos/reidolson35-netizen/reids-party/pages -F https_enforced=true`).
Site then lives at https://reidsparty.com (admin at /admin.html); the
github.io URL redirects.

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
- The public repo contains code only - no passcode, no data (`.gitignore`
  covers `token.txt`, `Code.local.gs`, `responses.json`, `uploads/`).
- IDs are sensitive: when the party's done, consider deleting the
  "Reid's Party Uploads" folder.
