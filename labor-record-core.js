// ===== 勞檢出勤表：共用核心（2026-11-25 從 labor-record-page.js 拆出）=====
// 用在：勞檢出勤表（labor-record.html，店長以上）、查看薪水（my-salary.html，員工看自己的那張）。
// 兩邊看到的是同一張表、同一個勞基法檢查、同一個內容指紋（簽名綁它）。
// ⚠️ 只讀 stores/{店}/attendance、weeks、employees 與 account；不寫打卡資料。
// ⚠️ 本檔只有 lr／LR 開頭的名稱：查看薪水頁也會載入，頂層撞名會讓整頁全滅（reference_refactor_safety_net）。
// 依賴：shift-utils.js、holidays.js、rest-days.js。

var lrConfig = { stores: [] };   // 頁面載入時換成 settings/globalConfig（lrLoad 要 stores 讀三店打卡）
// 電子簽名從這個薪資月開始（使用者 2026-11-25：「下一次發布的薪資月份」＝11 月）；之前的月份出勤表一律「未經電子簽署」
const LR_ESIGN_START = '2026-11';

function lrEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const lrPad = n => String(n).padStart(2, '0');
const lrYmd = d => `${d.getFullYear()}-${lrPad(d.getMonth() + 1)}-${lrPad(d.getDate())}`;
const lrHm = ms => { const d = new Date(ms); return `${lrPad(d.getHours())}:${lrPad(d.getMinutes())}`; };
// 時數顯示：「8小時」「6小時50分」（原本 8:00 容易被看成 8 點；使用者 2026-09-28）
const lrHrs = h => { const m = Math.round(h * 60), H = Math.floor(m / 60), M = m % 60; return M ? `${H}小時${M}分` : `${H}小時`; };
const lrDec = h => Math.round(h * 100) / 100; // Excel 用小數小時（可加總）
const LR_WD = ['日', '一', '二', '三', '四', '五', '六'];
var LR_HOL = (typeof builtinHolidayMap === 'function') ? builtinHolidayMap() : {}; // 頁面打開時改用系統設定（syncHolidayMapInto）


// ───────── 讀資料 ─────────
/** @param onlyName 只讀這一個人（查看薪水用：員工只看自己的）；不給＝全店 */
async function lrLoad(store, ym, onlyName) {
  const [y, m] = ym.split('-').map(Number);
  const first = `${ym}-01`, last = `${ym}-${lrPad(new Date(y, m, 0).getDate())}`;
  // 例假／休息日以「週一～週日」為一週判斷 → 月初、月底的週要多讀前後幾天，才看得到整週
  const { from: rFirst, to: rLast } = rdWeekRange(first, last);
  const stores = (lrConfig.stores || []).filter(s => s && s !== '人力支援');

  // 人員：這個月有在職過一天的本店員工都列（使用者 2026-11-25 改：月中離職的也要列，原本 09-28 是離職就不列）
  // ⚠️ 離職日／調走日＝「第一天不在本店」（1 號離職＝當月沒上班，同 resignAccessUntil 的定義）→ 那天（含）以後算未在職
  //    離職卻沒有日期的：看不出哪個月走的，不列（避免把很久以前離職的人列進每個月）
  const empSnap = await window.db.collection('stores').doc(store).collection('employees').get();
  const emps = [];
  empSnap.forEach(d => {
    const e = d.data();
    if (d.id.startsWith('🆘')) return;
    if (onlyName && d.id !== onlyName) return;
    const eff = e.departDate || e.retireDate || e.transferDate || '';
    if (e.status === '離職' && !eff) return;
    if (['離職', '調走'].includes(e.status) && eff && eff <= first) return;
    if (e.startDate && e.startDate > last) return;
    emps.push({ name: d.id, role: e.role || '', pt: e.role === '工讀' || !!e.payAsPartTime, sortKey: e.sortKey ?? 999, status: e.status || '', eff: ['離職', '調走'].includes(e.status) ? eff : '', startDate: e.startDate || '' });
  });
  emps.sort((a, b) => a.sortKey - b.sortKey);
  const names = new Set(emps.map(e => e.name));

  // 顯示名稱（account.displayName）
  const disp = {};
  try { (await window.db.collection('account').where('store', '==', store).get()).forEach(d => { const a = d.data(); if (a.empName && a.displayName) disp[a.empName] = a.displayName; }); } catch (e) {}

  // 打卡：三店都要讀（支援日的班與打卡都記在對方店）；多讀一天接住最後一晚夜班的隔日下班
  const punches = [];
  await Promise.all(stores.map(async st => {
    const snap = await window.db.collection('stores').doc(st).collection('attendance').where('date', '>=', rFirst).where('date', '<=', shiftDateAdd(rLast, 1)).get();
    snap.forEach(d => { const r = d.data(); if (names.has(r.empName)) punches.push({ id: d.id, _store: st, ...r }); });
  }));

  // 班表：本店＋他店（他店的 🆘 待補格被本店員工認領＝去支援）
  // 每一天 → 「週次|星期」（用 shift-utils 的 shiftWeekStr／shiftDayName，不另寫週次公式）
  const dateOf = {}, weeks = [];
  for (let ds = rFirst; ds <= rLast; ds = shiftDateAdd(ds, 1)) {
    const w = shiftWeekStr(ds);
    dateOf[w + '|' + shiftDayName(ds)] = ds;
    if (!weeks.includes(w)) weeks.push(w);
  }
  const sched = {}; // name|date → [{shift, where}]
  await Promise.all(stores.map(async st => {
    const snaps = await Promise.all(weeks.map(w => window.db.collection('stores').doc(st).collection('weeks').doc(w).get()));
    snaps.forEach((snap, i) => {
      if (!snap.exists) return;
      (snap.data().records || []).forEach(r => {
        const date = dateOf[weeks[i] + '|' + r.day];
        if (!date) return; // 不在讀取範圍
        const sh = String(r.shift || '').trim();
        if (!sh) return;
        const loc = String(r.location || '');
        if (st === store && names.has(r.name)) {
          // 本店班表；loc=支援X 是舊的衍生格（人去 X 店），照寫
          (sched[r.name + '|' + date] = sched[r.name + '|' + date] || []).push({ shift: sh, where: loc.startsWith('支援') ? loc.slice(2) : '' });
        } else if (st !== store && r.approvalStatus === 'approved' && String(r.supportEmp || '').startsWith(store + '-')) {
          const who = String(r.supportEmp).slice(store.length + 1);
          if (!names.has(who)) return;
          const k = who + '|' + date, arr = sched[k] = sched[k] || [];
          if (!arr.some(x => x.shift === sh && x.where === st)) arr.push({ shift: sh, where: st });
        }
      });
    });
  }));

  const hol = LR_HOL;
  return { store, ym, first, last, rFirst, rLast, emps, disp, punches, sched, hol };
}
// ───────── 整理成每人每天一列 ─────────
// 休的日子：沒排班或排休／指休，而且當天沒有任何打卡。特休、補休等請假不算（不能拿來抵例假或休息日）；
// 排了班但沒打卡算上班（多半是忘了打，不能當成休）。
const LR_REST = ['', '排休', '指休', '休', '例假', '休息日'];
function lrBuildEmp(D, emp) {
  const store = D.store;
  const recs = D.punches.filter(r => r.empName === emp.name);
  const gd = r => r.shiftDate || r.date;
  const t = r => (typeof r.tsMs === 'number' ? r.tsMs : Date.parse(r.deviceTs || ''));
  // 上下班配對：整段依時間順序配（不是逐日）——跨夜班的下班卡有些沒寫歸班日（shiftDate），
  // 逐日配會把 23:00 上班、隔天 01:10 下班拆成兩天各一張。上班後 16 小時內的下班算同一段，歸到上班那天。
  const MAX_SPAN = 16 * 3600000;
  const valid = recs.filter(r => !r.voided && r.status !== '缺卡' && (r.type === '上班' || r.type === '下班') && isFinite(t(r))).sort((a, b) => t(a) - t(b));
  const pairsBy = {};
  const put = (ds, pr) => (pairsBy[ds] = pairsBy[ds] || []).push(pr);
  let open = null;
  valid.forEach(p => {
    if (p.type === '上班') { if (open) put(gd(open), { in: open, out: null }); open = p; return; }
    if (open && t(p) - t(open) <= MAX_SPAN) { put(gd(open), { in: open, out: p }); open = null; return; }
    if (open) { put(gd(open), { in: open, out: null }); open = null; }
    put(gd(p), { in: null, out: p });
  });
  if (open) put(gd(open), { in: open, out: null });

  const employed = ds => (!emp.startDate || ds >= emp.startDate) && (!emp.eff || ds < emp.eff); // eff＝第一天不在本店
  const all = []; // 讀取範圍內（完整的週）每一天
  for (let ds = D.rFirst; ds <= D.rLast; ds = shiftDateAdd(ds, 1)) {
    const wd = LR_WD[new Date(ds + 'T00:00:00').getDay()];
    const holName = D.hol[ds] || '';
    const sc = D.sched[emp.name + '|' + ds] || [];
    const works = sc.some(x => !LR_REST.includes(x.shift) && !['特休', '補休'].includes(x.shift) && parseShiftSegs(x.shift).length > 0);
    // 去別店支援的日子，本店班表那天會是「排休」（人不在本店）→ 有上班的班就不列本店的排休／指休
    // （2026-11-25：原本印成「8-16（美德）、排休」，三店 37 筆；跟跨店支援顯示口徑一致：本店排休不可蓋過他店核准的支援班）
    const scShow = works ? sc.filter(x => !LR_REST.includes(x.shift)) : sc;
    const schedTxt = scShow.map(x => x.shift + (x.where && x.where !== store ? `（${x.where}）` : '')).join('、');
    const onLeave = sc.some(x => !LR_REST.includes(x.shift) && !(parseShiftSegs(x.shift).length > 0)); // 特休、補休、病假…
    const day = recs.filter(r => gd(r) === ds);
    const notes = [], st = { miss: 0, late: 0, lateMin: 0, fix: 0 };
    // 缺卡旗標：沒註銷＝還沒補；批次結案的也照實寫（沒有打卡就是沒有打卡）
    day.filter(r => r.status === '缺卡').forEach(r => {
      if (!r.voided) { notes.push(`${r.note || '缺卡'}（未補）`); st.miss++; }
      else if (r.batchClosed) { notes.push(`${r.note || '缺卡'}（未補，已結案）`); st.miss++; }
    });
    // 被註銷的打卡：照實列出
    day.filter(r => r.voided && r.status !== '缺卡' && isFinite(t(r))).forEach(r => notes.push(`已註銷 ${r.type || ''} ${lrHm(t(r))}${r.voidReason ? '（' + r.voidReason + '）' : ''}`));
    day.filter(r => !r.voided && r.status !== '缺卡' && r.type && r.type !== '上班' && r.type !== '下班' && isFinite(t(r)))
      .forEach(r => notes.push(`${r.type}打卡 ${lrHm(t(r))}`));
    const pairs = pairsBy[ds] || [];
    const spans = pairs.map(pr => ({ a: pr.in ? t(pr.in) : null, b: pr.out ? t(pr.out) : null })).filter(x => x.a != null && x.b != null && x.b > x.a);
    let hours = 0, complete = 0;
    // 時數（使用者 2026-11-25 改）：有排定班別＝依排班給足（跟薪資一致：薪資照班表時數發，遲到不扣時數），
    //   遲到／早退的分鐘只寫在備註；已核准加班、沒有對應班別（例：排休日出勤）才依實際打卡。
    // ⚠️ 原本是 min(實際, 排班)：遲到 8 分＋晚走 4 分被互相抵掉變成 7 小時 56 分，跟發薪、跟寫的規則都對不上。
    const cells = pairs.map(pr => {
      const a = pr.in ? t(pr.in) : null, b = pr.out ? t(pr.out) : null;
      const actual = (a != null && b != null && b > a) ? (b - a) / 3600000 : null;
      const shiftStr = (pr.in && pr.in.shift) || (pr.out && pr.out.shift) || '';
      // 兩頭班一天兩組卡：每組只給它對到的那一段（離上班卡最近的班段），不能每組都給整天時數
      const segs = parseShiftSegs(shiftStr);
      let seg = null;
      if (segs.length && a != null) seg = segs.reduce((x, y) => Math.abs(shiftTimeMs(ds, y.startH) - a) < Math.abs(shiftTimeMs(ds, x.startH) - a) ? y : x);
      else if (segs.length) seg = segs[0];
      const sc = seg ? seg.durH : 0;
      const otOk = (pr.in && pr.in.otStatus === 'approved') || (pr.out && pr.out.otStatus === 'approved');
      const h = actual == null ? null : (sc > 0 && !otOk ? sc : actual);
      if (h != null) { hours += h; complete++; }
      // 下班晚超過 30 分鐘（＝打卡頁會跳「加班或私事」的同一條門檻）又沒核准加班 → 備註寫清楚，避免被認定有加班事實
      if (seg && b != null && !otOk) {
        const over = Math.round((b - shiftTimeMs(ds, seg.endH)) / 60000);
        if (over > 30) {
          const o = pr.out || {};
          const why = o.otStatus === 'pending' ? '加班申請待審，核准後才計工時'
            : o.otStatus === 'rejected' ? '加班申請未核准，不計工時'
              : (o.otIntent === 'private' ? '本人申報為私事，' : '未申請加班，') + '超時為個人因素停留，不計工時';
          notes.push(`下班 ${lrHm(b)}（超過排定 ${over} 分）：${why}`);
        }
      }
      return { in: a != null ? lrHm(a) : '', out: b != null ? lrHm(b) : '', outNext: b != null && lrYmd(new Date(b)) !== ds, h };
    });
    // 每一筆打卡的註記（跟著配對走：跨夜的下班卡註記在上班那天）
    const pts = [];
    pairs.forEach(pr => { if (pr.in) pts.push(pr.in); if (pr.out) pts.push(pr.out); });
    pts.forEach(r => {
      const tag = [];
      if (r.type === '上班' && r.lateMin > 0) { tag.push(`遲到 ${r.lateMin} 分`); st.late++; st.lateMin += r.lateMin; }
      if (r.status === '早退') tag.push('早退');
      if (r.proxyBy) tag.push(`店長代補（${r.proxyBy}）`);
      else if (r.status === '補登' || r.source === 'manual') tag.push('補登');
      if (r.origTs && lrHm(Date.parse(r.origTs)) !== lrHm(t(r))) tag.push(`原打卡 ${lrHm(Date.parse(r.origTs))}`);
      if (r.otStatus === 'approved') tag.push('加班已核准');
      if (r._store !== store) tag.push(`於${r._store}`);
      if (r.status === '補登' || r.source === 'manual') st.fix++;
      if (tag.length) notes.push(`${r.type} ${lrHm(t(r))}：${tag.join('、')}`);
    });
    if (works && !pts.length && !day.some(r => r.status === '缺卡')) notes.push('無打卡紀錄');
    if (holName) notes.unshift(holName + (pts.length ? '出勤' : ''));
    const emp_ = employed(ds);
    // 國定假日沒上班＝「國」（勞基法 §37 休假）：不算例假／休息日，也不算進當月「休」的天數（2026-11-25，跟盤點資料同一規則）
    const holOff = emp_ && !pts.length && !works && !onLeave && !!holName;
    const rest = emp_ && !pts.length && !works && !onLeave && !holName;
    // 時數只在至少有一段完整上下班時才寫（只有一張卡寫 0:00 會被看成上了 0 小時）
    all.push({ date: ds, wd, holName, schedTxt, off: !works && !pts.length, cells, hours: complete ? hours : null, worked: pts.length > 0, notes, st,
      employed: emp_, rest, holOff, spans });
  }

  // ── 例假／休息日：規則在 rest-days.js（跟盤點資料共用）──
  rdLabelWeeks(all);
  // 工讀只寫「休」、不標例假／休息日與＊（使用者 2026-09-28）；整週無休照樣標（連上 7 天對工讀一樣違法）
  const partRole = emp.pt; // 職稱工讀、或按時薪計薪（使用者 2026-09-28：賴楷岳照工讀填）
  if (partRole) all.forEach(x => { x.restLabel = ''; x.star = false; });
  all.forEach(x => { if (x.noRest) x.notes.unshift('⚠️ 本週無休' + (partRole ? '' : '（例假出勤）')); });

  const rows = all.filter(x => x.date >= D.first && x.date <= D.last);
  const sum = { days: 0, hours: 0, late: 0, lateMin: 0, miss: 0, fix: 0, holDays: 0, rest: 0, star: 0, noRest: 0, satSun: 0 };
  rows.forEach(r => {
    if (r.worked) { sum.days++; sum.hours += r.hours || 0; if (r.holName) sum.holDays++; }
    sum.late += r.st.late; sum.lateMin += r.st.lateMin; sum.miss += r.st.miss; sum.fix += r.st.fix;
    if (r.rest) sum.rest++;
    if (r.star) sum.star++;
    if (r.noRest) sum.noRest++;
    if (r.wd === '六' || r.wd === '日') sum.satSun++;
  });
  return { emp, name: D.disp[emp.name] || emp.name, rows, sum, law: lrLawCheck(emp, all, D, sum) };
}

/**
 * 勞基法檢查（跟盤點資料 inspection-page.js 同一套規則，但用真實打卡＋班表）——只顯示紅字、不擋列印／Excel（使用者 2026-11-25）
 *   ① 正職：當月「休」的天數＝六日天數（國定假日沒上班的「國」不算在內）
 *   ② 七休一：連續 7 天沒有「休」（國定假日、特休、補休都不能斷開）
 *   ③ 前後兩天的班（依實際打卡）休息未滿 11 小時（同一天的兩頭班不算）
 */
function lrLawCheck(emp, all, D, sum) {
  const out = [];
  const md = s => s.slice(5).replace('-', '/');
  if (!emp.pt) {
    const inMonth = all.filter(x => x.date >= D.first && x.date <= D.last);
    if (inMonth.every(x => x.employed) && sum.rest !== sum.satSun) {
      const diff = sum.rest - sum.satSun;
      out.push(`當月休 ${sum.rest} 天，與六日天數 ${sum.satSun} 天不符（${diff > 0 ? '多休 ' + diff : '少休 ' + -diff} 天；國定假日不算）`);
    }
  }
  let run = [];
  const flush = () => {
    if (run.length >= 7 && run.some(d => d >= D.first && d <= D.last)) out.push(`${md(run[0])}~${md(run[run.length - 1])} 連續 ${run.length} 天沒有休（七休一）`);
    run = [];
  };
  all.forEach(x => { if (!x.employed || x.rest || (!x.worked && !x.holOff && !x.schedTxt)) flush(); else run.push(x.date); });
  flush();
  const spans = [];
  all.forEach(x => x.spans.forEach(sp => spans.push({ ...sp, date: x.date })));
  for (let i = 1; i < spans.length; i++) {
    const p = spans[i - 1], c = spans[i];
    if (p.date === c.date || c.date < D.first || c.date > D.last) continue;
    const g = Math.round((c.a - p.b) / 360000) / 10;
    if (g < 11) out.push(`${md(p.date)} 下班 → ${md(c.date)} 上班只隔 ${g} 小時（未滿 11 小時）`);
  }
  return out;
}


// ───────── 電子簽名：內容指紋 ─────────
/**
 * 出勤表的內容指紋：員工簽的是「這個版本」，之後打卡、補登、班表有異動，指紋就變 → 簽名失效要重簽。
 * 只取事實欄位（日期、班別／例假休息日國、上下班時間、時數），不取備註文字：
 * 備註的措辭以後改程式可能會變，不能因為改字就讓全部人重簽。
 */
function lrAttHash(x) {
  const s = x.rows.map(r => [r.date, r.holOff ? '國' : (r.restLabel || ''), r.schedTxt,
    r.cells.map(c => c.in + '-' + c.out).join(','), r.hours == null ? '' : Math.round(r.hours * 60)].join('|')).join(';');
  let h = 0x811c9dc5;   // FNV-1a 32 位元
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return 'a' + h.toString(16).padStart(8, '0') + s.length.toString(36);
}
/** 簽署時間到分鐘（使用者 2026-11-25） */
function lrSignedAtText(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}/${lrPad(d.getMonth() + 1)}/${lrPad(d.getDate())} ${lrPad(d.getHours())}:${lrPad(d.getMinutes())}`;
}
/**
 * 這張出勤表的電子簽名狀態
 * @param ack salaryAck 文件（可為 null）  @return {ok:true, at} | {ok:false, text}
 */
function lrAttSignState(ym, ack, hash) {
  if (ym < LR_ESIGN_START) return { ok: false, text: '出勤紀錄未經電子簽署' };
  if (!ack || !ack.signedAttHash) return { ok: false, text: '尚未電子簽署' };
  if (ack.signedAttHash !== hash) return { ok: false, text: '簽署後內容有異動，需重簽' };
  return { ok: true, at: ack.attSignedAt || ack.signedAt };
}

// ───────── 暫緩開放（當月有勞基法紅字）─────────
// stores/{店}/attRelease/{YYYY-MM}.names.{員工} = {by, at}：店長確認後按「開放給員工」寫入
async function lrLoadRelease(store, ym) {
  try { const d = await window.db.collection('stores').doc(store).collection('attRelease').doc(ym).get(); return (d.exists && d.data().names) || {}; }
  catch (e) { return {}; }
}
async function lrSetRelease(store, ym, name, by) {
  await window.db.collection('stores').doc(store).collection('attRelease').doc(ym)
    .set({ names: { [name]: { by: by || '', at: new Date().toISOString() } } }, { merge: true });
}
/** 取消開放（使用者 2026-11-25）：員工端回到「店長確認中」；已經簽過的簽名不會被刪 */
async function lrUnsetRelease(store, ym, name) {
  await window.db.collection('stores').doc(store).collection('attRelease').doc(ym)
    .update(new firebase.firestore.FieldPath('names', name), firebase.firestore.FieldValue.delete());
}
/** 員工端看不看得到：沒紅字＝看得到；有紅字＝店長開放才看得到 */
function lrVisibleToEmp(x, rel) { return !x.law.length || !!rel[x.emp.name]; }

// ───────── 一張出勤表（列印、查看薪水共用同一份 HTML）─────────
/**
 * @param sig 員工簽名欄：null＝空白（手簽）；{img, at, account, ver}＝電子簽名；{text}＝狀態字（尚未電子簽署…）
 */
function lrSheetHtml(D, x, sig) {
  const [y, m] = D.ym.split('-').map(Number);
  const empCell = sig && sig.img ? `<img class="sh-sig" src="${sig.img}" alt="員工電子簽名">`
    : sig && sig.text ? `<em class="sh-sigtxt">${lrEsc(sig.text)}</em>` : '';
  const dateCell = sig && sig.img ? lrEsc(lrSignedAtText(sig.at)) : '';
  return `
  <section class="sheet">
    <div class="sh-title">${lrEsc(D.store)}　出勤紀錄表</div>
    <div class="sh-sub"><span>姓名：<b>${lrEsc(x.name)}</b></span><span>職稱：${lrEsc(x.emp.role || '')}</span><span>期間：${y} 年 ${m} 月 1 日～${m} 月 ${+D.last.slice(8)} 日</span></div>
    <table class="sh-table">
      <thead><tr><th style="width:5%">日</th><th style="width:5%">星期</th><th style="width:13%">排定班別</th><th style="width:9%">上班</th><th style="width:11%">下班</th><th style="width:12%">時數</th><th>備註</th></tr></thead>
      <tbody>${x.rows.map(r => {
        const n = Math.max(1, r.cells.length);
        const cls = r.noRest ? 'norest' : (r.holName ? 'hol' : (r.off ? 'off' : ''));
        // 例假／休息日直接寫在排定班別（使用者 2026-09-28：不另開一欄）
        const schedCell = r.holOff ? '<b>國</b>' : r.restLabel ? `<b>${r.restLabel}${r.star ? '＊' : ''}</b>` : (r.rest && !r.schedTxt ? '休' : lrEsc(r.schedTxt));
        return Array.from({ length: n }, (_, i) => {
          const c = r.cells[i] || { in: '', out: '', outNext: false };
          const first = i === 0;
          return `<tr class="${cls}">
            ${first ? `<td rowspan="${n}">${+r.date.slice(8)}</td><td rowspan="${n}">${r.wd}</td><td rowspan="${n}">${schedCell}</td>` : ''}
            <td>${c.in}</td><td>${c.out}${c.outNext && c.out ? '<small>(次日)</small>' : ''}</td>
            ${first ? `<td rowspan="${n}">${r.hours != null ? lrHrs(r.hours) : ''}</td><td rowspan="${n}" class="nt">${lrEsc(r.notes.join('；'))}</td>` : ''}
          </tr>`;
        }).join('');
      }).join('')}</tbody>
    </table>
    <div class="sh-sum">出勤天數：${x.sum.days} 天　總時數：${lrHrs(x.sum.hours)}　遲到：${x.sum.late} 次（${x.sum.lateMin} 分）　缺卡未補：${x.sum.miss}　國定假日出勤：${x.sum.holDays} 天${x.emp.pt ? '' : `　本月休假：${x.sum.rest} 天（週六日 ${x.sum.satSun} 天）`}</div>
    ${x.sum.noRest ? `<div class="sh-norest">⚠️ 有 ${x.sum.noRest} 週整週無休（例假出勤）</div>` : ''}
    <div class="sh-foot">例假／休息日：每週一～週日，最後一個休假日為例假、倒數第二個為休息日（特休、補休不計入）。時數＝依排定班別計算（與薪資一致；遲到／早退分鐘記於備註）；已核准加班、無排班出勤者依實際打卡計算；下班超過排定時間 30 分鐘且未經核准加班者，於備註註明；上下班時間照實記載至分鐘；資料取自打卡系統，列印時間 ${lrYmd(new Date())} ${lrHm(Date.now())}。</div>
    <div class="sh-confirm">本人確認上列出勤紀錄及時數正確無誤。排定班別以外於店內停留而未依規定申請加班者，係本人個人因素之非工作停留（如用餐、休息、等候交通等），非屬延長工作時間。工作時間達 4 小時以上者，均已依法安排 30 分鐘以上休息時間（採輪休制且照常計薪）。</div>
    <div class="sh-sign"><div>${empCell}<span></span>員工簽名</div><div>${dateCell ? `<b class="sh-sigat">${dateCell}</b>` : ''}<span></span>${sig && sig.img ? '電子簽署時間' : '日期'}</div><div><span></span>店長</div></div>
    ${sig && sig.img ? `<div class="sh-esign">電子簽署：${lrEsc(lrSignedAtText(sig.at))}${sig.account ? `・帳號 ${lrEsc(sig.account)}` : ''}・出勤紀錄版本 ${lrEsc(sig.ver || '')}</div>` : ''}
  </section>`;
}
