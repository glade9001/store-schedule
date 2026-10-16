// 薪資修改紀錄（2026-10-16）：員工薪資視窗最下方的「📝 修改紀錄」。
// 資料由雲端函式 onSalaryEditLog 寫到 salaryEditLog/{店}__{月}（前端只能讀、不能改）。
// 預設收合，按了才讀；只列這個人的欄位變動，加上整個月的送審／發布／退回，看得出是發布前還是發布後改的。
(function () {
  const LABEL = {
    baseSalary: '底薪', fullAttendBonus: '全勤獎金', fullAttendBase: '全勤基準', otherBase: '其他底薪',
    roleBonus: '職務加給', mgmtOps: '營運獎勵', mgmtQuality: '品保獎勵', mgmtKPI: '營運指標', mgmtAccount: '帳務獎勵', mgmtLeader: '卓越領導',
    laborAllowance: '勞務津貼', performance: '績效獎金', nightAllowance: '夜班津貼', otherBonus: '其他加項', otherBonusNote: '其他加項備註',
    annualLeaveEncash: '特休折現', compLeaveEncash: '補休折現',
    otHours: '平日加班時數', otHoursManual: '加班時數手動', restDayOtHours: '休息日加班時數', restDayOtPay: '休息日加班費', holidayOtPay: '國定假日加班費',
    customOtEnabled: '自訂加班費率', customOtRate: '自訂加班時薪', customOtX134: '自訂費率×1.34',
    hourlySupportRate: '支援時薪', hourlySupportAmt: '支援費',
    wage: '時薪', hours: '工時', extraHours: '額外時數', holidayHours: '國定假日時數',
    lateMinutes: '遲到分鐘', personalSickLeave: '事病假扣款', otherDeduction: '其他扣款', otherDeductionNote: '扣款備註',
    laborInsurance: '勞保', healthInsurance: '健保', dependentInsurance: '眷屬健保', dependentCount: '眷屬人數', hasDependent: '有眷屬',
    healthUninsured: '健保未投保', insuranceGrade: '投保級距', laborPension: '勞退自提',
    laborEr: '勞保（公司）', healthEr: '健保（公司）', pensionEr: '勞退（公司）', companyPension: '勞退（公司）',
    role: '職稱', payAsPartTime: '以工讀計薪', givenLeave: '給假天數',
    unworkedCompDays: '應休未休天數', unworkedAction: '應休未休處理', unworkedCompGranted: '應休未休已補休',
    netAmt: '實發金額',
  };
  const STATUS = { draft: '草稿', submitted: '送審', published: '發布', rejected: '退回' };
  const PERM = { admin: '管理員', owner: '加盟主', manager: '店長', employee: '員工' };
  let cache = null, cacheKey = '', showAll = false, emp = '';

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const box = () => document.getElementById('empEditLog');
  const fmtT = ms => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const val = v => (v === '' || v == null ? '空' : v === 'true' ? '是' : esc(v));

  function line(it) {
    if (it.field === 'status') return `薪資狀態：${STATUS[it.from] || esc(it.from)} → <b>${STATUS[it.to] || esc(it.to)}</b>`;
    if (it.field === '_created') return '建立這個月的薪資';
    if (it.field === '_added') return '加入這個人';
    if (it.field === '_removed') return '移除這個人';
    return `${esc(LABEL[it.field] || it.field)}：${val(it.from)} → <b>${val(it.to)}</b>`;
  }

  function render() {
    const el = box(); if (!el) return;
    const mine = (cache || []).filter(it => it.emp === emp || it.emp === '');
    // 同一次存檔（同一個 at＋同一人）併成一組，新的在上面
    const groups = [];
    mine.sort((a, b) => b.at - a.at || a.seq - b.seq).forEach(it => {
      const g = groups[groups.length - 1];
      if (g && g.at === it.at && g.by === it.by) g.items.push(it); else groups.push({ at: it.at, by: it.by, byPerm: it.byPerm, items: [it] });
    });
    // 只有狀態變動、沒有這個人的欄位 → 仍列出（看得出改動在發布前或後）
    const shown = showAll ? groups : groups.slice(0, 5);
    const body = groups.length
      ? shown.map(g => `<div style="padding:8px 0;border-top:1px solid var(--border,#e5e7eb);">
          <div style="font-size:12px;color:var(--text-muted);font-weight:700;">${fmtT(g.at)}・${esc(g.by)}${g.byPerm ? `（${PERM[g.byPerm] || esc(g.byPerm)}）` : ''}</div>
          ${g.items.map(it => `<div style="font-size:13px;margin-top:2px;">${line(it)}</div>`).join('')}</div>`).join('')
        + (!showAll && groups.length > 5 ? `<button onclick="SalaryEditLog.more()" style="width:100%;margin-top:6px;padding:8px;border:none;border-radius:8px;background:#f1f3f4;font-size:13px;font-weight:700;cursor:pointer;">看全部 ${groups.length} 次</button>` : '')
      : '<div style="font-size:13px;color:var(--text-muted);padding:6px 0;">這個月還沒有修改紀錄</div>';
    el.innerHTML = `<div style="margin-top:14px;padding:10px 12px;border-radius:12px;background:var(--bg-soft,#f8fafc);">
      <div style="display:flex;align-items:center;"><b style="font-size:14px;">📝 修改紀錄</b>
      <button onclick="SalaryEditLog.close()" style="margin-left:auto;border:none;background:none;font-size:13px;color:var(--text-muted);cursor:pointer;">收起</button></div>
      ${body}
      <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">2026/10/16 起才有紀錄；紀錄由系統自動寫入，任何人都不能修改。班表帶進來的時數變動，會記在當時存檔的人名下。</div></div>`;
  }

  function collapsed() {
    const el = box(); if (!el) return;
    el.innerHTML = `<button onclick="SalaryEditLog.open()" style="width:100%;margin-top:14px;padding:10px;border:1px dashed var(--border,#cbd5e1);border-radius:12px;background:none;font-size:13px;font-weight:700;color:var(--text-muted);cursor:pointer;">📝 看修改紀錄（誰在什麼時候改了哪個金額）</button>`;
  }

  async function open() {
    const el = box(); if (!el) return;
    const key = `${currentStore}__${currentMonth}`;
    if (cacheKey !== key) {
      el.innerHTML = '<div style="margin-top:14px;font-size:13px;color:var(--text-muted);">讀取修改紀錄中…</div>';
      try {
        const snap = await window.db.collection('salaryEditLog').doc(key).get();
        cache = snap.exists ? (snap.data().items || []) : [];
        cacheKey = key;
      } catch (e) {
        el.innerHTML = `<div style="margin-top:14px;font-size:13px;color:var(--danger,#dc2626);">讀不到修改紀錄（${esc(e.code || e.message)}）</div>`;
        return;
      }
    }
    render();
  }

  window.SalaryEditLog = {
    // 開員工視窗時呼叫：換人就收合；換月份／門市時清快取
    reset(empName) { emp = empName; showAll = false; if (cacheKey !== `${currentStore}__${currentMonth}`) { cache = null; cacheKey = ''; } collapsed(); },
    open, close: collapsed,
    more() { showAll = true; render(); },
  };
})();
