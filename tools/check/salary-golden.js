// 薪資驗算（2026-10-16 整理第 3 階段建立）：用正式資料，把最近幾個月三店每個人的
//   工時、時薪支援時數、國定假日時數、應休天數、國定假日出勤、應發、扣款
// 用「現在的薪資頁程式」重算（不讀已發布快照），存成基準；改了薪資相關程式之後再算一次，必須一模一樣。
// 用法：node tools/check/salary-golden.js --save    （改程式前）
//       node tools/check/salary-golden.js --compare （改程式後；有差異 exit 1）
// ⚠️ 基準檔含薪資金額，存在 ~/.lixue-check/（不在 repo 裡；repo 是公開的）。輸出不印姓名。
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const { loadFront, list, getDoc, tag } = require('./lib');
const STORES = ['美德', '聯鑫', '錦花'];
const FILE = path.join(os.homedir(), '.lixue-check', 'salary-golden.json');
const MONTHS = Number(process.env.MONTHS || 3);

function lastMonths(n) {
  const d = new Date(), out = [];
  for (let k = 1; k <= n; k++) { const x = new Date(d.getFullYear(), d.getMonth() - k, 1); out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`); }
  return out;
}

async function compute() {
  const ctx = loadFront(['holidays.js', 'leave-rules.js', 'salary-calc.js', 'leave-settle.js', 'salary-page.js']);
  const out = {};
  for (const ym of lastMonths(MONTHS)) {
    const weeks = ctx.getMonthWeeks(ym);
    // 排班：三店當月各週合併（同 salary-page.js loadSalaryData；calcEmpHours 會按日去重）
    const sched = {};
    for (const st of STORES) for (const ws of weeks) {
      const d = await getDoc(`stores/${st}/weeks/${ws}`);
      (d && d.data.records || []).forEach(r => { (sched[ws] = sched[ws] || []).push(Object.assign({}, r, { _store: st })); });
    }
    for (const st of STORES) {
      const sal = await getDoc(`stores/${st}/salary/${ym}`);
      if (!sal || sal.data.status !== 'published') continue;   // 只比已發布的月份：草稿店長還在改，數字本來就會變
      const emps = (await list(`stores/${st}/employees`)).map(e => Object.assign({ name: e.id }, e.data));
      // 歷史月份：職稱以當月薪資記錄為準（同 loadSalaryData）
      emps.forEach(e => { const h = (sal.data.records || []).find(r => r.empName === e.name); if (h && h.role) e.role = h.role; });
      ctx.__S = { sched, emps, ym, st, recs: sal.data.records || [] };
      vm.runInContext('scheduleData = __S.sched; empList = __S.emps; currentMonth = __S.ym; currentStore = __S.st; salaryData = { status: "draft", records: __S.recs };', ctx);
      for (const rec of sal.data.records || []) {
        const n = rec.empName; if (!n) continue;
        const r = JSON.parse(JSON.stringify(rec)); delete r.grossAmt; delete r.deductAmt; delete r.netAmt;   // 不讀快照，照公式重算
        const row = {};
        const safe = (k, f) => { try { const v = f(); row[k] = typeof v === 'number' ? Math.round(v * 100) / 100 : v; } catch (e) { row[k] = 'ERR ' + e.message; } };
        safe('hours', () => ctx.calcEmpHours(n).totalH);
        safe('supportH', () => ctx.calcHourlySupportHours(n));
        safe('holidayH', () => ctx.calcEmpHolidayHours(n));
        safe('offDays', () => ctx.calcMonthOffDays(n, ym));
        safe('holidayWork', () => JSON.stringify((ctx.detectHolidayWork(n, ym) || []).map(h => h.date)));
        safe('gross', () => ctx.calcGross(r));
        safe('deduct', () => ctx.calcDeduct(r));
        out[`${st}|${ym}|${n}`] = row;
      }
    }
  }
  return out;
}

(async () => {
  const mode = process.argv[2];
  const cur = await compute();
  const n = Object.keys(cur).length;
  if (mode === '--save') {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(cur));
    console.log(`已存基準：${n} 筆（${lastMonths(MONTHS).join('、')}）→ ${FILE}`);
    const errs = Object.entries(cur).filter(([, v]) => Object.values(v).some(x => String(x).startsWith('ERR')));
    if (errs.length) console.log('⚠️ 有算不出來的：', errs.length);
    return;
  }
  if (!fs.existsSync(FILE)) { console.log('  ⚠️  還沒有薪資驗算基準（這台電腦第一次跑）：node tools/check/salary-golden.js --save'); process.exit(0); }
  const base = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const diffs = [];
  const keys = Object.keys(cur).filter(k => base[k]);   // 只比兩邊都有的（月份往後推、新發布的月份不算差異）
  for (const k of keys) {
    const a = base[k] || {}, b = cur[k] || {};
    for (const f of new Set([...Object.keys(a), ...Object.keys(b)])) if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) {
      const [st, ym, name] = k.split('|'); diffs.push(`${st} ${ym} ${tag(name)} ${f}：${a[f]} → ${b[f]}`);
    }
  }
  console.log(diffs.length ? `  ❌ 薪資驗算有 ${diffs.length} 處不同（改了薪資公式？確定是要的改變才跑 --save 更新基準）：\n    ` + diffs.slice(0, 30).join('\n    ') : `  ✅ 薪資驗算（已發布月份重算 ${keys.length} 筆，每一欄都跟基準一樣）`);
  if (keys.length < 20) console.log('  ⚠️  比對筆數偏少，建議跑 --save 更新基準');
  process.exit(diffs.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
