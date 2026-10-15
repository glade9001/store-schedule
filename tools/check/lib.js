// 上線前檢查共用：拿 Firebase CLI 的登入（~/.config/configstore/firebase-tools.json）換 access token，
// 用 Firestore REST 唯讀讀正式資料。不寫入、不存任何資料到 repo（repo 是公開的）。
// 輸出一律不印員工姓名，用 tag() 轉成代號。
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');

const PROJECT = 'store-schedule-3b056';
const ROOT = path.resolve(__dirname, '../..');
const DOCS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

let _tok = null;
async function token() {
  if (_tok) return _tok;
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config/configstore/firebase-tools.json'), 'utf8'));
  // OAuth client 用 firebase-tools 套件自己的（不寫死在 repo 裡）
  const api = require(path.join(execSync('npm root -g').toString().trim(), 'firebase-tools/lib/api.js'));
  const r = await fetch('https://www.googleapis.com/oauth2/v4/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: api.clientId(), client_secret: api.clientSecret(), refresh_token: cfg.tokens.refresh_token, grant_type: 'refresh_token' }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('換 token 失敗（先在終端機跑 firebase login）：' + JSON.stringify(j).slice(0, 200));
  return (_tok = j.access_token);
}

/** Firestore REST 值 → JS */
function cv(v) {
  const k = Object.keys(v)[0], x = v[k];
  if (k === 'integerValue') return +x;
  if (k === 'doubleValue') return x;
  if (k === 'booleanValue') return x;
  if (k === 'nullValue') return null;
  if (k === 'timestampValue') { const ms = Date.parse(x); return { toMillis: () => ms, seconds: ms / 1000, toDate: () => new Date(ms) }; }
  if (k === 'mapValue') return Object.fromEntries(Object.entries(x.fields || {}).map(([a, b]) => [a, cv(b)]));
  if (k === 'arrayValue') return (x.values || []).map(cv);
  return x;
}
const docData = d => cv({ mapValue: d });
const enc = p => p.split('/').map(encodeURIComponent).join('/');

async function getDoc(p) {
  const r = await fetch(`${DOCS}/${enc(p)}`, { headers: { Authorization: 'Bearer ' + await token() } });
  if (r.status === 404) return null;
  const j = await r.json(); return j.fields ? { id: p.split('/').pop(), data: docData(j) } : null;
}
async function list(p) {
  const out = []; let pt = '';
  do {
    const r = await fetch(`${DOCS}/${enc(p)}?pageSize=300${pt ? '&pageToken=' + pt : ''}`, { headers: { Authorization: 'Bearer ' + await token() } });
    const j = await r.json();
    (j.documents || []).forEach(d => out.push({ id: d.name.split('/').pop(), path: d.name.split('/documents/')[1], data: docData(d) }));
    pt = j.nextPageToken;
  } while (pt);
  return out;
}
/** 所有同名子集合（collection group） */
async function group(coll) {
  const r = await fetch(`${DOCS}:runQuery`, { method: 'POST', headers: { Authorization: 'Bearer ' + await token(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId: coll, allDescendants: true }] } }) });
  return (await r.json()).filter(x => x.document).map(x => ({ id: x.document.name.split('/').pop(), path: x.document.name.split('/documents/')[1], data: docData(x.document) }));
}

/** 假的 Firestore（前端 compat SDK 形狀，唯讀）：給在 Node 裡直接跑頁面函式用 */
function fakeDb(capture) {
  const snapOf = (p, d) => ({ id: p.split('/').pop(), exists: !!d, data: () => d || undefined, ref: docRef(p) });
  let docRef = function (p) { return { id: p.split('/').pop(), path: p, get: async () => { const d = await getDoc(p); return snapOf(p, d && d.data); }, collection: c => collRef(p + '/' + c), set: ro, update: ro, delete: ro }; };
  function collRef(p) {
    const filt = [];
    const q = {
      doc: id => docRef(p + '/' + id),
      where: (f, op, v) => { filt.push([f, op, v]); return q; },
      orderBy: () => q, limit: () => q,
      get: async () => {
        let a = await list(p);
        for (const [f, op, v] of filt) a = a.filter(d => { const x = (typeof f === 'string' && f !== '__id') ? d.data[f] : d.id;
          return op === '==' ? x === v : op === '>=' ? x >= v : op === '<=' ? x <= v : op === '>' ? x > v : op === '<' ? x < v : op === 'in' ? v.includes(x) : true; });
        const docs = a.map(d => snapOf(d.path, d.data));
        return { docs, size: docs.length, empty: !docs.length, forEach: f => docs.forEach(f) };
      },
      onSnapshot: (ok, err) => { q.get().then(ok, err); return () => {}; },
    };
    return q;
  }
  function ro() { throw new Error('檢查程式不可寫入正式資料'); }
  // capture：只記錄要寫什麼（不寫入），給比對用
  const _docRef = docRef;
  if (capture) docRef = function (p) { const r = _docRef(p); r.set = async (d) => { capture.push({ path: p, data: d }); }; r.update = r.set; return r; };
  return { collection: c => collRef(c) };
}
const fakeFirebase = () => ({ firestore: Object.assign(() => fakeDb(), { FieldPath: { documentId: () => '__id' }, FieldValue: {}, Timestamp: { fromDate: d => ({ toMillis: () => +d }) } }) });

/** 在沙盒裡載入前端檔案（依序），回傳 context */
function loadFront(files, extra) {
  const el = () => ({ style: {}, innerHTML: '', textContent: '', value: '', placeholder: '', clientWidth: 360, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, querySelector: () => el(), querySelectorAll: () => [], addEventListener() {} });
  const els = {};
  const ctx = Object.assign({
    console, Date, Math, JSON, Promise, URLSearchParams, setTimeout, clearTimeout, setInterval: () => 0,
    window: { db: fakeDb() }, firebase: fakeFirebase(),
    document: { getElementById: id => (els[id] = els[id] || el()), createElement: el, head: { appendChild() {} }, body: el(), querySelector: () => el(), querySelectorAll: () => [], visibilityState: 'visible', addEventListener() {} },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }, location: { search: '', href: '' }, navigator: { userAgent: 'node' },
  }, extra || {});
  ctx.els = els; ctx.db = ctx.window.db; ctx.window = ctx;   // 跟瀏覽器一樣：window 就是全域（window.SalaryCalc＝SalaryCalc）
  vm.createContext(ctx);
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  return ctx;
}

/** 姓名 → 代號（輸出不露名字） */
function tag(name) { let h = 7; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return '#' + (h % 10000); }

const results = [];
function ok(name, detail) { results.push({ ok: true, name }); console.log('  ✅ ' + name + (detail ? '（' + detail + '）' : '')); }
function bad(name, detail) { results.push({ ok: false, name }); console.log('  ❌ ' + name + (detail ? '：' + detail : '')); }
function warn(name, detail) { console.log('  ⚠️  ' + name + (detail ? '：' + detail : '')); }
function done() { const f = results.filter(r => !r.ok).length; console.log(f ? `\n${f} 項沒過` : '\n全部通過'); process.exit(f ? 1 : 0); }

module.exports = { PROJECT, ROOT, token, getDoc, list, group, fakeDb, loadFront, tag, ok, bad, warn, done, cv };
