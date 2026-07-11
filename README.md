# REID'S PARTY

Application page for Reid's party - a neon, one-question-at-a-time form with a
private Google Sheet backend and a passcode-locked review dashboard.

- `index.html` - the application (what applicants see)
- `admin.html` - review dashboard (passcode required; data never lives here)
- `config.js` - submission endpoint URL
- `apps-script/Code.gs` - Google Apps Script backend (Sheet + Drive + email)
- `mock_server.py` - local stand-in backend for offline demo/testing

See `SETUP.md` for deployment, domain, and operations.
