/**
 * REID'S PARTIES — backend (Cloudflare Worker + D1)
 *
 * Replaces the Google Apps Script backend as the system of record:
 *  - POST (no token): accepts an application → D1. Never depends on Google,
 *    so nothing expires. Also best-effort forwards to the legacy Apps Script
 *    (keeps the Google Sheet mirror + notify email working while its grant
 *    is alive) — a forward failure never affects the applicant.
 *  - POST {action:'list'|'setStatus'|'delete'|'import', token, ...}: admin.
 *    (GET ?action=list&token=… kept for the verify script.)
 *  - GET /img/<key>: applicant-uploaded images (unguessable random keys).
 *
 * Abuse protection (the reason this Worker exists — Apps Script can't see
 * IPs): per-IP submission limit, small global daily cap, and a per-IP
 * bad-token lockout. Counters live in D1 (fixed one-hour / one-day windows).
 *
 * Secrets: ADMIN_TOKEN (wrangler secret) — same passcode admin.html uses.
 */

var STATUSES = ['PENDING', 'ACCEPTED', 'WAITLIST', 'REJECTED'];
var REQUIRED = ['email', 'name', 'socials', 'age', 'why', 'working', 'contrarian', 'want', 'phone'];
var IMG_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
var SUB_PER_IP_HOUR = 5;
var SUB_GLOBAL_DAY = 300;
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

function rowOut(r, origin) {
  var imgs = [], ids = [];
  try { imgs = JSON.parse(r.images_json || '[]'); } catch (e) {}
  try { ids = JSON.parse(r.id_images_json || '[]'); } catch (e) {}
  var abs = function (u) { return u.indexOf('img:') === 0 ? origin + '/img/' + u.slice(4) : u; };
  return {
    n: r.n, ts: r.ts, status: r.status, name: r.name, age: r.age,
    email: r.email, phone: r.phone, socials: r.socials,
    why: r.why, working: r.working, contrarian: r.contrarian, want: r.want || '',
    images: imgs.map(abs), id_images: ids.map(abs)
  };
}

async function listAll(env, origin) {
  var res = await env.DB.prepare('SELECT * FROM applications ORDER BY n').all();
  return (res.results || []).map(function (r) { return rowOut(r, origin); });
}

async function requireToken(env, ip, token) {
  if (token === env.ADMIN_TOKEN) return null;
  var fails = await bump(env, 'tok:' + ip, 3600);
  return json({ ok: false, error: fails > BADTOKEN_PER_IP_HOUR ? 'too many attempts' : 'bad token' });
}

async function submit(env, ctx, p, rawBody, ip) {
  /* honeypot — silently swallow bots (still costs them rate budget) */
  if (p.hp) return json({ ok: true, n: 0 });

  var a = p.answers || {};
  for (var i = 0; i < REQUIRED.length; i++) {
    if (!String(a[REQUIRED[i]] || '').trim()) {
      return json({ ok: false, error: 'Missing required field: ' + REQUIRED[i] });
    }
  }
  var age = parseInt(a.age, 10);
  if (!(age >= 1 && age <= 120)) return json({ ok: false, error: 'Enter your real age.' });
  if (!(age >= 20)) return json({ ok: false, error: '20+ only.' });
  var why = String(a.why).trim();
  if (why.length < 10 || why.length > 140) return json({ ok: false, error: '"Why" must be 10–140 characters.' });

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
    'INSERT INTO applications(ts,status,name,age,email,phone,socials,why,working,contrarian,want,images_json,ua) ' +
    'VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING n'
  ).bind(
    String(p.ts || new Date().toISOString()), 'PENDING',
    String(a.name).trim(), age, String(a.email).trim(), String(a.phone).trim(),
    String(a.socials).trim(), why, String(a.working).trim(), String(a.contrarian).trim(),
    String(a.want).trim(), JSON.stringify(imgRefs.map(function (k) { return 'img:' + k; })),
    String(p.ua || '').slice(0, 400)
  ).first();
  var n = row.n;
  if (imgRefs.length) {
    try {
      await env.DB
        .prepare('UPDATE images SET n=? WHERE key IN (' + imgRefs.map(function () { return '?'; }).join(',') + ')')
        .bind(n, ...imgRefs).run();
    } catch (e) {}
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

    /* GET: health + legacy-style list (used by verify_endpoint.sh) */
    if (request.method === 'GET') {
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

    /* ---- admin actions ---- */
    if (p.action) {
      var gate2 = await requireToken(env, ip, String(p.token || ''));
      if (gate2) return gate2;

      if (p.action === 'list') return json({ ok: true, rows: await listAll(env, origin) });

      if (p.action === 'setStatus') {
        if (STATUSES.indexOf(p.status) < 0) return json({ ok: false, error: 'bad status' });
        var u = await env.DB.prepare('UPDATE applications SET status=? WHERE n=?').bind(p.status, p.n).run();
        return u.meta.changes ? json({ ok: true }) : json({ ok: false, error: 'applicant not found' });
      }

      if (p.action === 'delete') {
        await env.DB.prepare('DELETE FROM images WHERE n=?').bind(p.n).run();
        var d = await env.DB.prepare('DELETE FROM applications WHERE n=?').bind(p.n).run();
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

    /* ---- public submission (rate-limited before anything else) ---- */
    var perIp = await bump(env, 'sub:' + ip, 3600);
    if (perIp > SUB_PER_IP_HOUR) {
      return json({ ok: false, error: 'Too many attempts from your network — try again in an hour.' });
    }
    var global = await bump(env, 'sub:GLOBAL', 86400);
    if (global > SUB_GLOBAL_DAY) {
      return json({ ok: false, error: 'We’re getting a lot of applications right now — please try again tomorrow.' });
    }
    return submit(env, ctx, p, raw, ip);
  }
};
