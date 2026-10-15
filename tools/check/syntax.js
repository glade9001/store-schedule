// ① 語法與載入：所有前端 JS 能解析、頁面沒有撞名／未定義呼叫、雲端函式都能載入且每個 export 都是函式
// 抓過的實例：module 撞名整頁失效、漏 import 的 ReferenceError（語法檢查抓不到 → check-globals）、
// 一行註解吃掉後半行程式（2026-10-15 auto-schedule-draft.js）。
const { execSync } = require('child_process'), path = require('path');
const { ROOT, ok, bad } = require('./lib');

console.log('① 語法與載入');
const files = execSync('git ls-files "*.js"', { cwd: ROOT }).toString().split('\n')
  .filter(f => f && !f.startsWith('docs/') && !f.includes('node_modules'));
const failed = [];
for (const f of files) {
  try { execSync(`node --check "${f}"`, { cwd: ROOT, stdio: 'pipe' }); }
  catch (e) { failed.push(f + '：' + String(e.stderr || e.message).split('\n').find(l => /Error/.test(l))); }
}
failed.length ? bad('JS 語法', failed.join('；')) : ok('JS 語法', files.length + ' 個檔');

try { execSync('node tools/check-globals.js --check', { cwd: ROOT, stdio: 'pipe' }); ok('頁面撞名／未定義呼叫（check-globals）'); }
catch (e) { bad('頁面撞名／未定義呼叫（check-globals）', String(e.stdout || '').split('\n').filter(l => l.includes('❌')).join('；')); }

// 雲端函式的未定義變數：require 載入不會報錯、要到函式被觸發才炸（2026-10-16 firebase-admin 14 拿掉 admin.firestore() 的教訓）
try {
  execSync('npx --yes eslint@8.57.0 --no-eslintrc --env node,es2022 --parser-options=ecmaVersion:latest --rule "no-undef:error" functions/*.js', { cwd: ROOT, stdio: 'pipe' });
  ok('雲端函式未定義變數（ESLint no-undef）');
} catch (e) {
  const out = String(e.stdout || '') + String(e.stderr || '');
  /no-undef/.test(out) ? bad('雲端函式未定義變數', out.split('\n').filter(l => /error/.test(l)).slice(0, 5).join('；')) : require('./lib').warn('雲端函式未定義變數', '跑不了 ESLint（要網路下載一次）');
}

try {
  const m = require(path.join(ROOT, 'functions/index.js'));
  const names = Object.keys(m);
  const noEp = names.filter(k => !(m[k] && m[k].__endpoint));
  noEp.length ? bad('雲端函式 export', '這些不是 Cloud Function（部署會失敗）：' + noEp.join('、')) : ok('雲端函式載入', names.length + ' 支');
} catch (e) { bad('雲端函式載入', e.message.split('\n')[0]); }

module.exports = {};
if (require.main === module) require('./lib').done();
