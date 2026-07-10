// REID'S PARTIES — shared config for index.html/apply.html (form) and admin.html
//
// ENDPOINT = the Cloudflare Worker backend (worker/ in this repo): D1 storage,
// per-IP rate limiting, never expires. It best-effort mirrors each submission
// to the legacy Apps Script (Google Sheet + notify email) while that grant is
// alive — see worker/wrangler.toml LEGACY_EXEC.
// When empty and running on localhost, the pages automatically use the local
// mock server (mock_server.py) at /exec so you can demo everything offline.
window.PARTY_CONFIG = {
  ENDPOINT: "https://reidsparty-api.reid-f55.workers.dev"
};
