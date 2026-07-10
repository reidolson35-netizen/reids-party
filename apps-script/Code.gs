/**
 * REID'S PARTY — backend (Google Apps Script Web App)
 *
 * Endpoints:
 *  - POST (no token): accepts an application, saves optional images to a
 *    private Drive folder, appends a row to a private Google Sheet, emails you.
 *  - GET ?action=list&token=…: returns every application as JSON (admin page).
 *  - POST {action:'setStatus', token, n, status}: updates a row's status.
 *  - POST {action:'delete', token, n}: permanently deletes a row.
 *
 * Scopes are deliberately minimal (see appsscript.json): spreadsheets,
 * drive.file (only files this script creates), send-mail, user email.
 * Drive access goes through the Drive v3 advanced service so the broad
 * DriveApp scope is never requested — that scope is "restricted" and made
 * Google hard-block the consent screen.
 */

var TOKEN = 'PASTE_PASSCODE_HERE';   // also what you type into admin.html
var NOTIFY_EMAIL = true;         // email you on every new application
var SHEET_NAME = "Reid's Party Applications";
var FOLDER_NAME = "Reid's Party Uploads";
var HEADERS = ['#','Timestamp','Status','Name','Age','Email','Phone','Socials',
               'Why','Working On','Contrarian','Images','ID','User Agent','Want'];

/* ---------------- plumbing ---------------- */

function json_(o){
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSpreadsheet_(){
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('SPREADSHEET_ID');
  if (id){
    try { return SpreadsheetApp.openById(id); } catch (e) {}
  }
  // create via Drive API (drive.file scope), then open via the Sheets scope
  var f = Drive.Files.create({
    name: SHEET_NAME,
    mimeType: 'application/vnd.google-apps.spreadsheet'
  });
  var ss = SpreadsheetApp.openById(f.id);
  var sh = ss.getSheets()[0];
  sh.setName('Applications');
  sh.appendRow(HEADERS);
  sh.setFrozenRows(1);
  props.setProperty('SPREADSHEET_ID', f.id);
  return ss;
}

function getFolderId_(){
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('FOLDER_ID');
  if (id) return id;
  var folder = Drive.Files.create({
    name: FOLDER_NAME,
    mimeType: 'application/vnd.google-apps.folder'
  });
  props.setProperty('FOLDER_ID', folder.id);
  return folder.id;
}

function pad_(n){
  n = String(n);
  while (n.length < 3) n = '0' + n;
  return n;
}

function splitLines_(v){
  v = String(v || '').trim();
  return v ? v.split('\n') : [];
}

/* ---------------- entrypoints ---------------- */

function doGet(e){
  var q = (e && e.parameter) || {};
  if (q.action === 'list'){
    if (q.token !== TOKEN) return json_({ok:false, error:'bad token'});
    var sh = getSpreadsheet_().getSheets()[0];
    var last = sh.getLastRow();
    var rows = [];
    if (last > 1){
      var vals = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
      for (var i = 0; i < vals.length; i++){
        var v = vals[i];
        rows.push({
          n: v[0], ts: v[1], status: v[2], name: v[3], age: v[4],
          email: v[5], phone: String(v[6]).replace(/^'/, ''), socials: v[7],
          why: v[8], working: v[9], contrarian: v[10],
          images: splitLines_(v[11]),
          id_images: splitLines_(v[12]),   // pre-2026-07 rows only: Drive links
          want: v[14] || ''
        });
      }
    }
    return json_({ok:true, rows:rows});
  }
  return json_({ok:true, service:"reids-party"});
}

function doPost(e){
  try{
    var p = JSON.parse(e.postData.contents);
    if (p.action === 'setStatus') return setStatus_(p);
    if (p.action === 'delete') return deleteApp_(p);
    return submit_(p);
  } catch(err){
    return json_({ok:false, error:'bad request: ' + err});
  }
}

/* ---------------- handlers ---------------- */

function submit_(p){
  if (p.hp) return json_({ok:true, n:0});   // honeypot — silently swallow bots

  var a = p.answers || {};
  var required = ['email','name','socials','age','why','working','contrarian','want','phone'];
  for (var i = 0; i < required.length; i++){
    if (!String(a[required[i]] || '').trim()){
      return json_({ok:false, error:'Missing required field: ' + required[i]});
    }
  }
  var age = parseInt(a.age, 10);
  if (!(age >= 20)) return json_({ok:false, error:'20+ only.'});
  var why = String(a.why).trim();
  if (why.length < 10 || why.length > 140) return json_({ok:false, error:'"Why" must be 10–140 characters.'});

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try{
    var ss = getSpreadsheet_();
    var sh = ss.getSheets()[0];
    if (String(sh.getRange(1, HEADERS.length).getValue()) === ''){
      sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);  // backfills new columns on a pre-existing sheet
    }
    var n = sh.getLastRow();           // header is row 1 → first applicant is №1
    var imgUrls = saveImages_(p.images || [], n, 'img', 5);
    sh.appendRow([
      n, new Date(), 'PENDING',
      String(a.name).trim(), age, String(a.email).trim(), "'" + String(a.phone).trim(),
      String(a.socials).trim(), why, String(a.working).trim(), String(a.contrarian).trim(),
      imgUrls.join('\n'), '' /* ID column kept for pre-July rows */, String(p.ua || ''), String(a.want).trim()
    ]);

    if (NOTIFY_EMAIL){
      try{
        MailApp.sendEmail(
          Session.getEffectiveUser().getEmail(),
          'Party application №' + pad_(n) + ' — ' + a.name + ', ' + age,
          'WHY:\n' + a.why + '\n\n' +
          'WANT:\n' + a.want + '\n\n' +
          'WORKING ON:\n' + a.working + '\n\n' +
          'CONTRARIAN:\n' + a.contrarian + '\n\n' +
          'Socials: ' + a.socials + '\n' +
          'Email: ' + a.email + '\n' +
          'Phone: ' + a.phone + '\n\n' +
          'Sheet: ' + ss.getUrl()
        );
      } catch(mailErr){ /* mail quota issues must never lose an application */ }
    }
    return json_({ok:true, n:n});
  } finally {
    lock.releaseLock();
  }
}

function saveImages_(arr, n, tag, cap){
  if (!arr || !arr.length) return [];
  var folderId = getFolderId_();
  var urls = [];
  for (var i = 0; i < Math.min(arr.length, cap); i++){
    var f = arr[i] || {};
    var b64 = String(f.data || '');
    if (b64.indexOf(',') >= 0) b64 = b64.split(',').pop();
    if (!b64) continue;
    var blob = Utilities.newBlob(
      Utilities.base64Decode(b64),
      f.type || 'image/jpeg',
      pad_(n) + '-' + tag + '-' + (i + 1) + '.jpg'
    );
    var file = Drive.Files.create(
      {name: blob.getName(), parents: [folderId]},
      blob,
      {fields: 'id'}
    );
    urls.push('https://drive.google.com/file/d/' + file.id + '/view');
  }
  return urls;
}

function setStatus_(p){
  if (p.token !== TOKEN) return json_({ok:false, error:'bad token'});
  var allowed = ['PENDING','ACCEPTED','WAITLIST','REJECTED'];
  if (allowed.indexOf(p.status) < 0) return json_({ok:false, error:'bad status'});
  var sh = getSpreadsheet_().getSheets()[0];
  var last = sh.getLastRow();
  for (var r = 2; r <= last; r++){
    if (String(sh.getRange(r, 1).getValue()) === String(p.n)){
      sh.getRange(r, 3).setValue(p.status);
      return json_({ok:true});
    }
  }
  return json_({ok:false, error:'applicant not found'});
}

function deleteApp_(p){
  if (p.token !== TOKEN) return json_({ok:false, error:'bad token'});
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try{
    var sh = getSpreadsheet_().getSheets()[0];
    var last = sh.getLastRow();
    for (var r = 2; r <= last; r++){
      if (String(sh.getRange(r, 1).getValue()) === String(p.n)){
        sh.deleteRow(r);
        return json_({ok:true});
      }
    }
    return json_({ok:false, error:'applicant not found'});
  } finally {
    lock.releaseLock();
  }
}
