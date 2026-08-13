/**
 * REID'S PARTIES - backend (Cloudflare Worker + D1)
 *
 * Replaces the Google Apps Script backend as the system of record:
 *  - POST (no token): accepts an application → D1. Never depends on Google,
 *    so nothing expires. Also best-effort forwards to the legacy Apps Script
 *    (keeps the Google Sheet mirror + notify email working while its grant
 *    is alive) - a forward failure never affects the applicant.
 *  - POST {action:'list'|'setStatus'|'delete'|'import', token, ...}: admin.
 *    (GET ?action=list&token=… kept for the verify script.)
 *  - GET /img/<key>: applicant-uploaded images (unguessable random keys).
 *  - GET /hit: pixel visit counter (day x page x source, no PII).
 *    GET ?action=hits&token=…: read the counters.
 *
 * Abuse protection (the reason this Worker exists - Apps Script can't see
 * IPs): per-IP submission limit, small global daily cap, and a per-IP
 * bad-token lockout. Counters live in D1 (fixed one-hour / one-day windows).
 *
 * Secrets: ADMIN_TOKEN (wrangler secret) - same passcode admin.html uses.
 */

var STATUSES = ['PENDING', 'ACCEPTED', 'PROBABLY YES', 'WAITLIST', 'REJECTED'];
/* email left out on purpose: the form is phone-only now (acceptance goes out
   by text - "nobody checks their email"); legacy rows still carry emails */
var REQUIRED = ['name', 'socials', 'age', 'why', 'working', 'contrarian', 'hobby', 'want'];

/* Reid's copy (straight apostrophes on purpose: keeps SMS in GSM-7, fewer segments) */
function waiverMsg(link) {
  return "You've been accepted.\n\n" +
    "We reviewed your application for Reid's Parties, and we think you're a great fit!\n\n" +
    'One last thing: Please fill out this code of conduct.\n\n' + link + '\n\n' +
    'This is to keep our parties friendly and safe.';
}
function waiverThanksMsg() {
  return "Thanks! We got your signed code of conduct. We'll send you the address on September 4th. It will be in Central Austin.";
}
var IMG_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
/* Shared IPs are normal here (venue wifi at the parties, dorms), so the tight
   cap counts only ACCEPTED submissions; raw attempts get a loose flood guard. */
var SUB_OK_PER_IP_HOUR = 20;
var ATTEMPTS_PER_IP_HOUR = 120;
var SUB_GLOBAL_DAY = 2000;
var BADTOKEN_PER_IP_HOUR = 30;

var CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(o, status) {
  return new Response(JSON.stringify(o), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, CORS)
  });
}

function hex(bytes) {
  return Array.from(bytes).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

/* fixed-window rate counter in D1; returns the count for this window */
async function bump(env, base, windowSecs) {
  var now = Math.floor(Date.now() / 1000);
  var k = base + ':' + Math.floor(now / windowSecs);
  var row = await env.DB.prepare(
    'INSERT INTO rl(k,count,reset) VALUES(?,1,?) ON CONFLICT(k) DO UPDATE SET count=count+1 RETURNING count'
  ).bind(k, now + windowSecs).first();
  if (Math.random() < 0.02) {
    await env.DB.prepare('DELETE FROM rl WHERE reset < ?').bind(now).run();
  }
  return row ? row.count : 1;
}

/* profile hosts the existence check may fetch (never an open proxy); bare and
   legacy domains normalize to the variant that answers without a redirect */
var CHECK_HOSTS = {
  'instagram.com': 'www.instagram.com',
  'tiktok.com': 'www.tiktok.com',
  'facebook.com': 'www.facebook.com',
  'fb.com': 'www.facebook.com',
  'x.com': 'x.com',
  'twitter.com': 'x.com',
  'youtube.com': 'www.youtube.com'
};

/* Look a profile URL up. Definitive 404/410 => not_found; 200 => ok; anything
   else (login wall, bot wall, redirect, timeout) => unknown. Only not_found
   may pause the form, so a valid account can never be falsely rejected.
   ponytail: no per-platform body sniffing; platforms that stonewall
   datacenter IPs (Instagram, X) mostly come back unknown and that's fine. */
async function checkSocial(target) {
  var u;
  try { u = new URL(String(target || '')); } catch (e) { return 'unknown'; }
  var host = CHECK_HOSTS[u.hostname.replace(/^www\./, '').toLowerCase()];
  if (u.protocol !== 'https:' || !host || u.pathname.length < 2) return 'unknown';
  try {
    var r = await fetch('https://' + host + u.pathname + u.search, {
      redirect: 'manual',
      signal: AbortSignal.timeout(4000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (r.status === 404 || r.status === 410) return 'not_found';
    if (r.status !== 200) return 'unknown';
    /* TikTok 200s missing users; its page JSON carries a definitive
       user-not-found code (10221 today, 10202 historically). Bot shells
       have neither marker and stay unknown, so still fail-open. */
    if (host === 'www.tiktok.com') {
      var body = await r.text();
      if (body.indexOf('"statusCode":10221') >= 0 || body.indexOf('"statusCode":10202') >= 0) return 'not_found';
      return body.indexOf('"uniqueId":"') >= 0 ? 'ok' : 'unknown';
    }
    return 'ok';
  } catch (e) { return 'unknown'; }
}

function rowOut(r, origin) {
  var imgs = [], ids = [];
  try { imgs = JSON.parse(r.images_json || '[]'); } catch (e) {}
  try { ids = JSON.parse(r.id_images_json || '[]'); } catch (e) {}
  var abs = function (u) { return u.indexOf('img:') === 0 ? origin + '/img/' + u.slice(4) : u; };
  return {
    n: r.n, ts: r.ts, status: r.status, name: r.name, age: r.age,
    email: r.email, phone: r.phone, socials: r.socials,
    why: r.why, working: r.working, contrarian: r.contrarian, hobby: r.hobby || '', want: r.want || '',
    ref: r.ref || '', soc_check: r.soc_check || '',
    sign_key: r.sign_key || '', notified: r.notified || 0, sex: r.sex || '', notes: r.notes || '',
    bio: r.bio || '', guest_photo: r.guest_photo ? origin + '/img/' + r.guest_photo : '',
    images: imgs.map(abs), id_images: ids.map(abs)
  };
}

/* US-first E.164: 10 digits get +1; anything else must already carry a country code */
function e164(phone) {
  var d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) return '+1' + d;
  if (d.length >= 11 && d.length <= 15) return '+' + d;
  return '';
}

async function sendSms(env, to, body) {
  var r = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + env.TWILIO_SID + '/Messages.json', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + btoa(env.TWILIO_SID + ':' + env.TWILIO_TOKEN),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: body }).toString()
  });
  return r.status >= 200 && r.status < 300;
}

async function listAll(env, origin) {
  var res = await env.DB.prepare('SELECT * FROM applications ORDER BY n').all();
  /* pair each application with its signed waiver for the admin badge */
  var sres = await env.DB.prepare('SELECT DISTINCT app_n FROM waivers WHERE app_n IS NOT NULL').all();
  var signedSet = {};
  (sres.results || []).forEach(function (w) { signedSet[w.app_n] = 1; });
  return (res.results || []).map(function (r) {
    var o = rowOut(r, origin);
    o.signed = !!signedSet[r.n];
    return o;
  });
}

async function requireToken(env, ip, token) {
  if (token === env.ADMIN_TOKEN) return null;
  var fails = await bump(env, 'tok:' + ip, 3600);
  return json({ ok: false, error: fails > BADTOKEN_PER_IP_HOUR ? 'too many attempts' : 'bad token' });
}

async function submit(env, ctx, p, rawBody, ip) {
  /* honeypot - silently swallow bots (still costs them rate budget) */
  if (p.hp) return json({ ok: true, n: 0 });

  var a = p.answers || {};
  for (var i = 0; i < REQUIRED.length; i++) {
    if (!String(a[REQUIRED[i]] || '').trim()) {
      return json({ ok: false, error: 'Missing required field: ' + REQUIRED[i] });
    }
  }
  var phoneDigits = String(a.phone || '').replace(/\D/g, '');
  if (phoneDigits.length < 10 || phoneDigits.length > 15) {
    return json({ ok: false, error: 'Enter a real phone number.' });
  }
  var age = parseInt(a.age, 10);
  if (!(age >= 1 && age <= 120)) return json({ ok: false, error: 'Enter your real age.' });
  if (!(age >= 20 && age <= 28)) return json({ ok: false, error: 'Must be between 20-28.' });
  var why = String(a.why).trim();

  /* validation passed - only now does it count against the real caps */
  var okCount = await bump(env, 'sub:' + ip, 3600);
  if (okCount > SUB_OK_PER_IP_HOUR) {
    return json({ ok: false, error: 'Too many applications from your network. Try again in an hour.' });
  }
  var global = await bump(env, 'sub:GLOBAL', 86400);
  if (global > SUB_GLOBAL_DAY) {
    return json({ ok: false, error: 'We’re getting a lot of applications right now. Please try again tomorrow.' });
  }

  /* store optional images (unguessable keys); a bad image never sinks the application */
  var imgRefs = [];
  var imgs = Array.isArray(p.images) ? p.images.slice(0, 5) : [];
  for (var j = 0; j < imgs.length; j++) {
    var f = imgs[j] || {};
    var data = String(f.data || '');
    if (data.indexOf(',') >= 0) data = data.split(',').pop();
    var mime = IMG_TYPES.indexOf(f.type) >= 0 ? f.type : 'image/jpeg';
    if (!data || data.length > 2500000) continue;
    try {
      var key = hex(crypto.getRandomValues(new Uint8Array(16)));
      await env.DB.prepare('INSERT INTO images(key,n,idx,mime,data) VALUES(?,0,?,?,?)')
        .bind(key, j, mime, data).run();
      imgRefs.push(key);
    } catch (e) {}
  }

  var row = await env.DB.prepare(
    'INSERT INTO applications(ts,status,name,age,email,phone,socials,why,working,contrarian,hobby,want,images_json,ua,ref) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING n'
  ).bind(
    String(p.ts || new Date().toISOString()), 'PENDING',
    String(a.name).trim(), age, String(a.email).trim(), String(a.phone).trim(),
    String(a.socials).trim(), why, String(a.working).trim(), String(a.contrarian).trim(),
    String(a.hobby || '').trim(), String(a.want).trim(), JSON.stringify(imgRefs.map(function (k) { return 'img:' + k; })),
    String(p.ua || '').slice(0, 400), String(p.ref || '').slice(0, 300)
  ).first();
  var n = row.n;
  if (imgRefs.length) {
    try {
      await env.DB
        .prepare('UPDATE images SET n=? WHERE key IN (' + imgRefs.map(function () { return '?'; }).join(',') + ')')
        .bind(n, ...imgRefs).run();
    } catch (e) {}
  }

  /* stamp the socials existence verdict for the admin badge (post-response) */
  ctx.waitUntil(
    checkSocial(a.socials).then(function (v) {
      return env.DB.prepare('UPDATE applications SET soc_check=? WHERE n=?').bind(v, n).run();
    }).catch(function () {})
  );

  /* server-side TikTok conversion (Events API; no TikTok code runs in the browser).
     Deliberately minimal: ip/ua/ttclid only - never applicant email or phone. */
  if (env.TIKTOK_TOKEN) {
    var ttUser = { ip: ip, user_agent: String(p.ua || '').slice(0, 400) };
    var ttclid = String(p.ttclid || '').slice(0, 200);
    if (ttclid) ttUser.ttclid = ttclid;
    ctx.waitUntil(
      fetch('https://business-api.tiktok.com/open_api/v1.3/event/track/', {
        method: 'POST',
        headers: { 'Access-Token': env.TIKTOK_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_source: 'web',
          event_source_id: 'D9AQLNRC77UARCKB4K2G',
          data: [{
            event: 'Lead',
            event_time: Math.floor(Date.now() / 1000),
            user: ttUser,
            page: { url: 'https://reidsparty.com/apply.html' }
          }]
        })
      }).catch(function () {})
    );
  }

  /* server-side Meta conversion (Conversions API; no Meta code runs in the browser).
     Same stance as TikTok: ip/ua/fbclid only - never applicant email or phone.
     URL carries ?share so Reid's "URL contains share" custom conversion matches.
     Inert until META_PIXEL_ID + META_TOKEN secrets are set. */
  if (env.META_PIXEL_ID && env.META_TOKEN) {
    var fbUser = { client_ip_address: ip, client_user_agent: String(p.ua || '').slice(0, 400) };
    var fbclid = String(p.fbclid || '').slice(0, 200);
    if (fbclid) fbUser.fbc = 'fb.1.' + Date.now() + '.' + fbclid;
    ctx.waitUntil(
      fetch('https://graph.facebook.com/v25.0/' + env.META_PIXEL_ID + '/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_token: env.META_TOKEN,
          data: [{
            event_name: 'Lead',
            event_time: Math.floor(Date.now() / 1000),
            action_source: 'website',
            event_source_url: 'https://reidsparty.com/apply.html?share',
            user_data: fbUser
          }]
        })
      }).catch(function () {})
    );
  }

  /* best-effort mirror to the legacy Apps Script (Sheet + notify email) */
  if (env.LEGACY_EXEC) {
    ctx.waitUntil(
      fetch(env.LEGACY_EXEC, { method: 'POST', body: rawBody, redirect: 'follow' }).catch(function () {})
    );
  }
  return json({ ok: true, n: n });
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (e) {
      /* never leak an HTML 1101 page - the frontend expects JSON */
      return json({ ok: false, error: 'server error' }, 500);
    }
  },

};

async function handle(request, env, ctx) {
    var url = new URL(request.url);
    var ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
    var origin = url.origin;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    /* images */
    if (request.method === 'GET' && url.pathname.indexOf('/img/') === 0) {
      var key = url.pathname.slice(5);
      if (!/^[0-9a-f]{32}$/.test(key)) return new Response('not found', { status: 404, headers: CORS });
      var img = await env.DB.prepare('SELECT mime,data FROM images WHERE key=?').bind(key).first();
      if (!img) return new Response('not found', { status: 404, headers: CORS });
      var bin = Uint8Array.from(atob(img.data), function (c) { return c.charCodeAt(0); });
      return new Response(bin, {
        headers: Object.assign({ 'Content-Type': img.mime, 'Cache-Control': 'private, max-age=3600' }, CORS)
      });
    }

    /* GET /hit: visit beacon from the public pages (an <img> pixel, so no
       CORS preflight). Stores aggregated counters only - never IP/UA/PII. */
    if (request.method === 'GET' && url.pathname === '/hit') {
      /* ponytail: per-IP hourly cap (reuses rl) bounds junk ?src= row growth */
      if (await bump(env, 'hit:' + ip, 3600) <= 120) {
        var src = String(url.searchParams.get('r') || '').slice(0, 300);
        if (src.indexOf('://') > 0) {
          try { src = new URL(src).hostname.replace(/^www\./, ''); } catch (e) { src = ''; }
        }
        src = (src || '(direct)').toLowerCase().slice(0, 40);
        await env.DB.prepare(
          'INSERT INTO hits(day,page,src,n) VALUES(date(),?,?,1) ' +
          'ON CONFLICT(day,page,src) DO UPDATE SET n=n+1'
        ).bind(String(url.searchParams.get('p') || '/').slice(0, 40), src).run();
      }
      return new Response(null, { status: 204, headers: CORS });
    }

    /* GET: health + legacy-style list (used by verify_endpoint.sh) */
    if (request.method === 'GET') {
      if (url.searchParams.get('action') === 'hits') {
        var gateH = await requireToken(env, ip, url.searchParams.get('token') || '');
        if (gateH) return gateH;
        return json({ ok: true, rows: (await env.DB.prepare('SELECT * FROM hits ORDER BY day DESC, n DESC').all()).results || [] });
      }
      if (url.searchParams.get('action') === 'list') {
        var gate = await requireToken(env, ip, url.searchParams.get('token') || '');
        if (gate) return gate;
        return json({ ok: true, rows: await listAll(env, origin) });
      }
      return json({ ok: true, service: 'reidsparty-api' });
    }

    if (request.method !== 'POST') return json({ ok: false, error: 'not found' }, 404);

    var raw = await request.text();
    if (raw.length > 9000000) return json({ ok: false, error: 'request too large' });
    var p;
    try { p = JSON.parse(raw); } catch (e) { return json({ ok: false, error: 'bad request' }); }

    /* ---- public socials existence check (the form calls this on Next) ---- */
    if (p.action === 'check') {
      var tries = await bump(env, 'try:' + ip, 3600);
      /* fail-open even when flooded: the form must never get stuck on this */
      if (tries > ATTEMPTS_PER_IP_HOUR) return json({ ok: true, result: 'unknown' });
      return json({ ok: true, result: await checkSocial(p.url) });
    }

    /* ---- guest list: any accepted guest's private k, or the admin token.
       Names go out as "First L." only; guests never see full names, and
       guests Reid hasn't sorted into a group yet stay invisible to guests. ---- */
    if (p.action === 'guestlist') {
      var gtries = await bump(env, 'try:' + ip, 3600);
      if (gtries > ATTEMPTS_PER_IP_HOUR) return json({ ok: false, error: 'invalid link' });
      var isAdmin = String(p.token || '') !== '' && String(p.token || '') === env.ADMIN_TOKEN;
      if (!isAdmin) {
        var gk = String(p.k || '');
        if (!/^[0-9a-f]{32}$/.test(gk)) return json({ ok: false, error: 'invalid link' });
        var gapp = await env.DB.prepare("SELECT * FROM applications WHERE sign_key=? AND status='ACCEPTED'").bind(gk).first();
        if (!gapp) return json({ ok: false, error: 'invalid link' });
        /* the about-me is the price of admission: no bio yet -> the page shows
           the form instead of the list */
        if (!String(gapp.bio || '').trim()) return json({ ok: true, needsBio: true, name: String(gapp.name || '') });
      }
      var gres = await env.DB.prepare("SELECT * FROM applications WHERE status='ACCEPTED' ORDER BY name COLLATE NOCASE").all();
      var out = [];
      (gres.results || []).forEach(function (g) {
        var gsex = (g.sex === 'M' || g.sex === 'F') ? g.sex : '';
        if (!gsex && !isAdmin) return;
        var disp = String(g.list_name || '').trim() || String(g.name || '').trim();
        out.push({ name: disp, sex: gsex,
                   mine: (!isAdmin && gapp && g.n === gapp.n) ? 1 : undefined,
                   bio: String(g.bio || ''), photo: g.guest_photo ? origin + '/img/' + g.guest_photo : '' });
      });
      var me = (!isAdmin && gapp) ? {
        name: String(gapp.list_name || '').trim() || String(gapp.name || ''),
        bio: String(gapp.bio || ''),
        photo: gapp.guest_photo ? origin + '/img/' + gapp.guest_photo : ''
      } : null;
      return json({ ok: true, admin: isAdmin, rows: out, me: me });
    }

    /* ---- guest fills in their "a little about me" (+ optional photo) via
       their private ?k= link. Bio is required, photo optional; this is what
       unlocks the guest list for them and what shows up next to their name. ---- */
    if (p.action === 'guestbio') {
      var btries = await bump(env, 'try:' + ip, 3600);
      if (btries > ATTEMPTS_PER_IP_HOUR) return json({ ok: false, error: 'invalid link' });
      var bk = String(p.k || '');
      if (!/^[0-9a-f]{32}$/.test(bk)) return json({ ok: false, error: 'invalid link' });
      var bapp = await env.DB.prepare("SELECT n,guest_photo FROM applications WHERE sign_key=? AND status='ACCEPTED'").bind(bk).first();
      if (!bapp) return json({ ok: false, error: 'invalid link' });
      var bio = String(p.bio || '').trim().slice(0, 2000);
      if (!bio) return json({ ok: false, error: 'Please write a little about yourself.' });
      var lname = String(p.name || '').trim().slice(0, 120) || null;
      /* no migration framework here: make sure the column exists, ignore "already exists" */
      try { await env.DB.prepare('ALTER TABLE applications ADD COLUMN list_name TEXT').run(); } catch (e) {}
      var photoKey = null;
      var pdata = p.photo && String(p.photo.data || '');
      if (pdata) {
        if (pdata.indexOf(',') >= 0) pdata = pdata.split(',').pop();
        if (pdata.length && pdata.length <= 2500000) {
          try {
            photoKey = hex(crypto.getRandomValues(new Uint8Array(16)));
            var pmime = IMG_TYPES.indexOf(p.photo.type) >= 0 ? p.photo.type : 'image/jpeg';
            await env.DB.prepare('INSERT INTO images(key,n,idx,mime,data) VALUES(?,?,100,?,?)')
              .bind(photoKey, bapp.n, pmime, pdata).run();
          } catch (e) { photoKey = null; }
        }
      }
      if (photoKey) {
        await env.DB.prepare('UPDATE applications SET bio=?, list_name=?, guest_photo=? WHERE n=?').bind(bio, lname, photoKey, bapp.n).run();
        /* drop the previous photo so re-submits don't orphan rows */
        if (bapp.guest_photo) { try { await env.DB.prepare('DELETE FROM images WHERE key=?').bind(bapp.guest_photo).run(); } catch (e) {} }
      } else {
        await env.DB.prepare('UPDATE applications SET bio=?, list_name=? WHERE n=?').bind(bio, lname, bapp.n).run();
      }
      return json({ ok: true });
    }

    /* ---- who does this signing link belong to (waiver.html?k=...) ---- */
    if (p.action === 'waiverinfo') {
      var vtries = await bump(env, 'try:' + ip, 3600);
      if (vtries > ATTEMPTS_PER_IP_HOUR) return json({ ok: false, error: 'invalid link' });
      var vk = String(p.k || '');
      if (!/^[0-9a-f]{32}$/.test(vk)) return json({ ok: false, error: 'invalid link' });
      var vapp = await env.DB.prepare("SELECT n,name FROM applications WHERE sign_key=? AND status='ACCEPTED'").bind(vk).first();
      if (!vapp) return json({ ok: false, error: 'invalid link' });
      var vsigned = await env.DB.prepare('SELECT n FROM waivers WHERE app_n=?').bind(vapp.n).first();
      return json({ ok: true, name: vapp.name, signed: !!vsigned });
    }

    /* ---- signed waiver: ONLY through a private accepted-applicant link.
       The public waiver.html link on the site is read-only by design. ---- */
    if (p.action === 'waiver') {
      var wtries = await bump(env, 'try:' + ip, 3600);
      if (wtries > ATTEMPTS_PER_IP_HOUR) {
        return json({ ok: false, error: 'Too many attempts from your network. Try again in an hour.' });
      }
      var wk = String(p.k || '');
      if (!/^[0-9a-f]{32}$/.test(wk)) return json({ ok: false, error: 'This signing link isn’t active.' });
      var wapp = await env.DB.prepare("SELECT n,phone FROM applications WHERE sign_key=? AND status='ACCEPTED'").bind(wk).first();
      if (!wapp) return json({ ok: false, error: 'This signing link isn’t active.' });
      var already = await env.DB.prepare('SELECT n FROM waivers WHERE app_n=?').bind(wapp.n).first();
      if (already) return json({ ok: false, error: 'Already signed - you’re all set.' });
      var wname = String(p.name || '').trim().slice(0, 120);
      var wsig = String(p.sig || '');
      if (!wname) return json({ ok: false, error: 'Missing name.' });
      /* a real signature PNG is a few KB; 400k chars bounds abuse */
      if (wsig.indexOf('data:image/png;base64,') !== 0 || wsig.length > 400000) {
        return json({ ok: false, error: 'Missing signature.' });
      }
      if (p.agreed !== true) return json({ ok: false, error: 'You have to agree to the code of conduct.' });
      /* ip+ua stored on purpose: they are the evidence this signature is real */
      var wrow = await env.DB.prepare(
        'INSERT INTO waivers(ts,name,sig,ip,ua,app_n) VALUES(?,?,?,?,?,?) RETURNING n'
      ).bind(
        String(p.ts || new Date().toISOString()).slice(0, 40), wname, wsig,
        ip, String(p.ua || '').slice(0, 400), wapp.n
      ).first();
      /* confirmation text, right away (post-response; a Twilio blip never sinks the waiver) */
      if (env.TWILIO_SID && env.TWILIO_TOKEN && env.TWILIO_FROM) {
        var wto = e164(wapp.phone);
        if (wto) ctx.waitUntil(sendSms(env, wto, waiverThanksMsg()).catch(function () {}));
      }
      return json({ ok: true, n: wrow.n });
    }

    /* ---- admin actions ---- */
    if (p.action) {
      var gate2 = await requireToken(env, ip, String(p.token || ''));
      if (gate2) return gate2;

      if (p.action === 'list') return json({ ok: true, rows: await listAll(env, origin) });

      if (p.action === 'setStatus') {
        if (STATUSES.indexOf(p.status) < 0) return json({ ok: false, error: 'bad status' });
        var sn = parseInt(p.n, 10);
        if (!sn) return json({ ok: false, error: 'applicant not found' });
        if (p.status === 'ACCEPTED') {
          /* stamp approval: mint the private signing link (kept across
             re-approvals) and start the notify grace clock. notified stays
             as-is so flapping the status never re-texts anyone. */
          var cur = await env.DB.prepare('SELECT sign_key FROM applications WHERE n=?').bind(sn).first();
          if (!cur) return json({ ok: false, error: 'applicant not found' });
          var skey = cur.sign_key || hex(crypto.getRandomValues(new Uint8Array(16)));
          await env.DB.prepare("UPDATE applications SET status='ACCEPTED', sign_key=?, accepted_ts=? WHERE n=?")
            .bind(skey, Math.floor(Date.now() / 1000), sn).run();
          return json({ ok: true });
        }
        var u = await env.DB.prepare('UPDATE applications SET status=? WHERE n=?').bind(p.status, sn).run();
        return u.meta.changes ? json({ ok: true }) : json({ ok: false, error: 'applicant not found' });
      }

      /* Reid's "Send approval text" button (the 10s cancel window lives in
         admin.html - by the time this arrives, he means it). preview:true
         returns the exact message so he can Copy-text it into his Burner
         app manually while Twilio is unconfigured. */
      if (p.action === 'notify') {
        var nn = parseInt(p.n, 10);
        if (!nn) return json({ ok: false, error: 'applicant not found' });
        var napp = await env.DB.prepare('SELECT n,name,phone,status,sign_key,notified FROM applications WHERE n=?').bind(nn).first();
        if (!napp) return json({ ok: false, error: 'applicant not found' });
        if (napp.status !== 'ACCEPTED') return json({ ok: false, error: 'Approve them first - the text carries their signing link.' });
        var nkey = napp.sign_key;
        if (!nkey) {
          nkey = hex(crypto.getRandomValues(new Uint8Array(16)));
          await env.DB.prepare('UPDATE applications SET sign_key=? WHERE n=?').bind(nkey, nn).run();
        }
        var nmsg = waiverMsg('https://reidsparty.com/waiver.html?k=' + nkey);
        var nto = e164(napp.phone);
        if (p.preview) return json({ ok: true, msg: nmsg, to: nto || String(napp.phone || '') });
        if (!env.TWILIO_SID || !env.TWILIO_TOKEN || !env.TWILIO_FROM) {
          return json({ ok: false, error: 'Twilio isn’t configured yet - use Copy text and send it from your phone.' });
        }
        if (!nto) return json({ ok: false, error: 'No usable phone number on this application.' });
        var nok = false;
        try { nok = await sendSms(env, nto, nmsg); } catch (e) {}
        if (!nok) return json({ ok: false, error: 'Twilio rejected the send. Try again.' });
        await env.DB.prepare('UPDATE applications SET notified=1, notified_ts=? WHERE n=?').bind(new Date().toISOString(), nn).run();
        return json({ ok: true });
      }

      /* which group a guest lands in on the guest list (the form never asks) */
      if (p.action === 'setSex') {
        var xn = parseInt(p.n, 10);
        var xs = (p.sex === 'M' || p.sex === 'F') ? p.sex : '';
        if (!xn) return json({ ok: false, error: 'applicant not found' });
        var xu = await env.DB.prepare('UPDATE applications SET sex=? WHERE n=?').bind(xs, xn).run();
        return xu.meta.changes ? json({ ok: true }) : json({ ok: false, error: 'applicant not found' });
      }

      /* Reid's private per-applicant notes - admin-token only; never selected
         by the public guestlist/waiverinfo queries */
      if (p.action === 'setNotes') {
        var on = parseInt(p.n, 10);
        if (!on) return json({ ok: false, error: 'applicant not found' });
        var ou = await env.DB.prepare('UPDATE applications SET notes=? WHERE n=?')
          .bind(String(p.notes || '').slice(0, 5000), on).run();
        return ou.meta.changes ? json({ ok: true }) : json({ ok: false, error: 'applicant not found' });
      }

      if (p.action === 'waivers') {
        var wres = await env.DB.prepare('SELECT n,ts,name,sig,ip,ua,app_n FROM waivers ORDER BY n DESC').all();
        return json({ ok: true, rows: wres.results || [] });
      }

      if (p.action === 'delwaiver') {
        var wn = parseInt(p.n, 10);
        if (!wn) return json({ ok: false, error: 'waiver not found' });
        var wdel = await env.DB.prepare('DELETE FROM waivers WHERE n=?').bind(wn).run();
        return wdel.meta.changes ? json({ ok: true }) : json({ ok: false, error: 'waiver not found' });
      }

      if (p.action === 'delete') {
        var dn = parseInt(p.n, 10);
        if (!dn) return json({ ok: false, error: 'applicant not found' });
        await env.DB.prepare('DELETE FROM images WHERE n=?').bind(dn).run();
        var d = await env.DB.prepare('DELETE FROM applications WHERE n=?').bind(dn).run();
        return d.meta.changes ? json({ ok: true }) : json({ ok: false, error: 'applicant not found' });
      }

      if (p.action === 'import') {
        /* one-time migration from the Apps Script list payload */
        var rows = Array.isArray(p.rows) ? p.rows : [];
        for (var i = 0; i < rows.length; i++) {
          var r = rows[i];
          await env.DB.prepare(
            'INSERT OR REPLACE INTO applications(n,ts,status,name,age,email,phone,socials,why,working,contrarian,want,images_json,id_images_json,ua) ' +
            'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
          ).bind(
            r.n, String(r.ts || ''), STATUSES.indexOf(r.status) >= 0 ? r.status : 'PENDING',
            String(r.name || ''), parseInt(r.age, 10) || 0, String(r.email || ''), String(r.phone || ''),
            String(r.socials || ''), String(r.why || ''), String(r.working || ''), String(r.contrarian || ''),
            String(r.want || ''), JSON.stringify(r.images || []), JSON.stringify(r.id_images || []), 'imported'
          ).run();
        }
        return json({ ok: true, imported: rows.length });
      }

      return json({ ok: false, error: 'bad request' });
    }

    /* ---- public submission ---- */
    var attempts = await bump(env, 'try:' + ip, 3600);
    if (attempts > ATTEMPTS_PER_IP_HOUR) {
      return json({ ok: false, error: 'Too many attempts from your network. Try again in an hour.' });
    }
    return submit(env, ctx, p, raw, ip);
}
