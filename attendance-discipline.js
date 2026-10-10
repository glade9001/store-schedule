// ===== 出勤紀律指標（共用）：缺卡率／補登率／遲到率／App 打卡率 =====
// 消費端：owner-dashboard（三店出勤紀律追蹤）、performance（單店統計分析）。改口徑只改這裡。
// 分母「班數」＝當月有配到班別的上下班卡＋缺卡單，以「人｜班別日｜班別」去重（排班表不用另外讀）。
// 缺卡單：因「已補登／代為補登」被註銷的照算（缺卡確實發生過）；因排班變更等原因被註銷的不算（那張單本來就不成立）。
// App 打卡率＝App 打的上下班卡 ÷（App 卡＋補登核准寫入的卡），看員工是不是真的用 App 打卡。
(function(global){
  async function monthRequests(store, ym){
    try{ const q=await window.db.collection('stores').doc(store).collection('attendanceRequests').where('targetDate','>=',ym+'-01').where('targetDate','<=',ym+'-31').get(); return q.docs.map(d=>d.data()); }
    catch(e){ return []; }
  }
  function of(att, reqs){
    const keys=new Set(); let miss=0, missOpen=0, late=0, ins=0, app=0, manual=0;
    att.forEach(a=>{
      const day=a.shiftDate||a.date;
      if(a.type==='缺卡'){
        if(a.voided && !/補登/.test(a.voidReason||'')) return;
        miss++; if(!a.voided) missOpen++;
        if(a.shift) keys.add(a.empName+'|'+day+'|'+a.shift);
        return;
      }
      if(!a.voided && (a.type==='上班'||a.type==='下班')){
        if(a.source==='app') app++; else if(a.source==='manual') manual++;
      }
      if(a.voided || !a.shift || a.status==='到場' || (a.type!=='上班'&&a.type!=='下班')) return;
      keys.add(a.empName+'|'+day+'|'+a.shift);
      if(a.type==='上班'){ ins++; if(a.status==='遲到') late++; }
    });
    const req=(reqs||[]).length, shifts=keys.size;
    const pct=(a,b)=>b?Math.round(a/b*1000)/10:null;
    return {shifts, miss, missOpen, req, late, ins, app, manual,
      missRate:pct(miss,shifts), reqRate:pct(req,shifts), lateRate:pct(late,ins), appRate:pct(app,app+manual)};
  }
  // 一家店一個月：沒有任何打卡資料回 null（不是 0：0% 缺卡是合法數字，不能拿來代表「沒資料」）
  async function month(store, ym){
    const a=await window.db.collection('stores').doc(store).collection('attendance').where('date','>=',ym+'-01').where('date','<=',ym+'-31').get();
    if(a.empty) return null;
    return of(a.docs.map(d=>d.data()), await monthRequests(store, ym));
  }
  global.AttDisc = { monthRequests, of, month };
})(window);
