#!/usr/bin/env node
/* End-to-end browser test for the application flow, via raw Chrome DevTools
 * Protocol (no deps; needs Node >= 22 for built-in WebSocket + fetch).
 *
 * Prereqs: mock_server.py on :8765, Chrome headless with
 *   --remote-debugging-port=9222
 * Run: node test_e2e.js
 *
 * What it does: walks the real form in a real browser — intro → 10 questions
 * (skips the optional image step, checks the under-20 gate) → submit →
 * success screen → verifies the row via the API.
 * Also reports per-step horizontal overflow (layout regression guard).
 */
'use strict';

const fs = require('fs');
const SITE = process.env.RP_SITE || 'http://localhost:8765/';   // e.g. https://…github.io/reids-party/
const EXEC = process.env.RP_EXEC || (SITE + 'exec');            // backend URL when SITE is the live page
const CDP = 'http://127.0.0.1:9222';
const TOKEN = fs.existsSync(__dirname + '/token.txt')
  ? fs.readFileSync(__dirname + '/token.txt', 'utf8').trim() : 'partypass';

let ws, msgId = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function eval_(expression, awaitPromise = false) {
  const r = await send('Runtime.evaluate', {
    expression, awaitPromise, returnByValue: true
  });
  if (r.exceptionDetails) {
    throw new Error('page eval failed: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails, null, 0).slice(0, 500));
  }
  return r.result ? r.result.value : undefined;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitFor(expr, timeoutMs = 8000, label = expr) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await eval_(expr)) return true;
    await sleep(150);
  }
  throw new Error('timeout waiting for: ' + label);
}

async function shot(path) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path, Buffer.from(r.data, 'base64'));
}

const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  — ' + extra : ''));
}

async function typeIntoActive(value) {
  await eval_(`(function(){
    var el = document.querySelector('.step.on input.inp, .step.on textarea.inp');
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', {bubbles:true}));
    return true;
  })()`);
}

async function clickNext() {
  const stepBefore = await eval_(`[].indexOf.call(document.querySelectorAll('.step'), document.querySelector('.step.on'))`);
  await eval_(`(function(){
    var b = document.querySelectorAll('.step.on .nav .btn');
    b[b.length - 1].click();
    return true;
  })()`);
  await waitFor(
    `[].indexOf.call(document.querySelectorAll('.step'), document.querySelector('.step.on')) !== ${stepBefore}`,
    8000, 'step advance from ' + stepBefore
  );
}

async function activeStep() {
  return eval_(`[].indexOf.call(document.querySelectorAll('.step'), document.querySelector('.step.on'))`);
}

(async () => {
  // -- connect ---------------------------------------------------------------
  const target = await (await fetch(CDP + '/json/new?' + encodeURIComponent(SITE), { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')); });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true
  });
  await send('Page.navigate', { url: SITE + 'apply.html' });
  await waitFor(`document.querySelectorAll('.step').length === 12`, 10000, 'app built');
  await sleep(700); // fonts

  // -- layout: no horizontal overflow on any step -----------------------------
  const overflow = await eval_(`(function(){
    var bad = [];
    var steps = document.querySelectorAll('.step');
    for (var i = 0; i < steps.length; i++){
      steps.forEach ? null : null;
      var prev = document.querySelector('.step.on');
      if (prev) prev.classList.remove('on');
      steps[i].classList.add('on');
      var sw = document.documentElement.scrollWidth;
      if (sw > window.innerWidth + 1) bad.push(i + ':' + sw + '>' + window.innerWidth);
      steps[i].classList.remove('on');
    }
    steps[0].classList.add('on');
    return bad.join(', ');
  })()`);
  check('no horizontal overflow on any step', overflow === '', overflow || ('innerWidth=' + await eval_('window.innerWidth')));

  // -- intro → q1 --------------------------------------------------------------
  await eval_(`document.querySelector('.step.on .btn').click(); true`);
  await waitFor(`(function(){var s=document.querySelector('.step.on');return s && s===document.querySelectorAll('.step')[1];})()`, 5000, 'q1 visible');
  check('intro APPLY advances to q1', true);

  await typeIntoActive('jeri@test.com');   await clickNext();           // 1 email
  await typeIntoActive('Jeri Athan');      await clickNext();           // 2 name
  await typeIntoActive('instagram.com/_reidolson'); await clickNext();  // 3 socials

  // 4 age — under-20 gate first
  await typeIntoActive('19');
  await sleep(100);
  const gateErr = await eval_(`document.querySelector('.step.on .err').textContent`);
  const gateDisabled = await eval_(`(function(){var b=document.querySelectorAll('.step.on .nav .btn');return b[b.length-1].disabled;})()`);
  check('under-20 blocks NEXT with message', gateDisabled && /20/.test(gateErr), JSON.stringify(gateErr));
  await typeIntoActive('27'); await clickNext();

  // 5 why — char-count gate
  await typeIntoActive('short');
  const whyDisabled = await eval_(`(function(){var b=document.querySelectorAll('.step.on .nav .btn');return b[b.length-1].disabled;})()`);
  check('why <10 chars keeps NEXT disabled', whyDisabled === true);
  await typeIntoActive('I throw great toasts and clean up after.');
  await clickNext();

  await typeIntoActive('An automated video editing brain called Jeriathan.\nIt cuts dialogue like Reid does.');
  await clickNext();                                                    // 6 working

  // 7 images — optional, test SKIP path
  const skipLabel = await eval_(`(function(){var b=document.querySelectorAll('.step.on .nav .btn');return b[b.length-1].textContent;})()`);
  check('optional empty step shows SKIP', /skip/i.test(skipLabel), skipLabel);
  await clickNext();

  await typeIntoActive('Most parties are bad because of the host, not the guests.');
  await clickNext();                                                    // 8 contrarian
  await typeIntoActive('Real friends, and maybe a partner.');
  await clickNext();                                                    // 9 want
  await typeIntoActive('(555) 867-5309');                               // 10 phone — last question
  const lastStep = await activeStep();
  check('arrived at last step (10, phone)', lastStep === 10, 'step=' + lastStep);

  const submitLabel = await eval_(`(function(){var b=document.querySelectorAll('.step.on .nav .btn');return b[b.length-1].textContent;})()`);
  check('final button says SUBMIT', /submit/i.test(submitLabel), submitLabel);

  // -- submit ------------------------------------------------------------------
  await eval_(`(function(){var b=document.querySelectorAll('.step.on .nav .btn');b[b.length-1].click();return true})()`);
  await waitFor(`(function(){var s=document.querySelectorAll('.step');return s[s.length-1].classList.contains('on');})()`, 15000, 'success screen');
  const thanks = await eval_(`(document.querySelector('.step.on .bigYellow')||{}).textContent || ''`);
  check('success screen shows thank-you', /thank you/i.test(thanks), JSON.stringify(thanks));
  const friends = await eval_(`/friends applied too/i.test(document.querySelector('.step.on').textContent)`);
  check('success screen invites friends', friends === true);
  const hasShare = await eval_(`!!Array.from(document.querySelectorAll('.step.on .btn')).find(function(b){return /share/i.test(b.textContent);})`);
  check('success screen has Share button', hasShare === true);
  await shot('/tmp/rp_success.png');

  // -- verify through the API ----------------------------------------------------
  const list = await (await fetch(EXEC + '?action=list&token=' + encodeURIComponent(TOKEN), {redirect: 'follow'})).json();
  const row = (list.rows || []).filter(r => r.name === 'Jeri Athan').pop();
  check('row exists in store via API', !!row);
  if (row) {
    check('row fields round-trip', row.name === 'Jeri Athan' && row.age === 27 &&
      row.email === 'jeri@test.com' && row.images.length === 0 &&
      row.want === 'Real friends, and maybe a partner.',
      JSON.stringify({ name: row.name, age: row.age, want: row.want }));

    // delete path — remove the row we just made and confirm it's gone
    const del = await (await fetch(EXEC, {method:'POST', body: JSON.stringify({action:'delete', token: TOKEN, n: row.n})})).json();
    check('delete removes the application', del.ok === true, JSON.stringify(del));
    const after = await (await fetch(EXEC + '?action=list&token=' + encodeURIComponent(TOKEN))).json();
    check('deleted row no longer listed', !(after.rows||[]).some(function(x){ return x.n === row.n; }));
  }

  const fails = results.filter(r => !r.ok).length;
  console.log('\n' + (fails ? 'E2E: ' + fails + ' FAILURE(S)' : 'E2E: ALL ' + results.length + ' CHECKS PASSED'));
  ws.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('E2E ERROR:', e.message); try { ws && ws.close(); } catch (_) {} process.exit(2); });
