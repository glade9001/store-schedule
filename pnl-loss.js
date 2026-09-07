// ===== 盤點區間攤提（PnlLoss）=====
// 盤點每 60~90 天做一次，不是每月。盤損(invResult)是「整個區間」累積出來的結果，
// 原本整筆記在盤點當月，會造成兩種失真：
//   ① 無盤點月 → 淨損耗只含壞品＋現金短少，系統性偏樂觀，且與盤點月不可比
//   ② 盤點月   → 該月店長要背整個區間的盤損，分數被單月重擊
// 故一律改成把盤損平均攤到它所涵蓋的每個月。尚未盤點的月份，沿用「上一個完整區間的月均」估算(est)。
// 消費端：owner-dashboard(計分卡/決策警示/分享快照)、performance(淨損耗趨勢圖與三店比較指標)。
(function(global){
  const YM = /^\d{4}-\d{2}$/;
  const num = v => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
  const isStocktake = d => !!d && d.noStocktake !== true && d.invResult != null && isFinite(parseFloat(d.invResult));

  // pnlMap: { 'YYYY-MM': pnlDoc } → { 'YYYY-MM': {amort, months, srcYm, est} }
  // amort 與 invResult 同號(盤損為負)；區間內各月 amort 加總＝該次 invResult(除法餘數留在最後一個月，金額不流失)
  function build(pnlMap){
    const out = {};
    if (!pnlMap) return out;
    const months = Object.keys(pnlMap).filter(k => YM.test(k)).sort();
    if (!months.length) return out;

    let from = 0, lastPerMonth = null, lastSrc = '';
    months.forEach((m, i) => {
      if (!isStocktake(pnlMap[m])) return;
      const total = num(pnlMap[m].invResult);
      const slice = months.slice(from, i + 1);
      const per = total / slice.length;
      slice.forEach((mm, k) => {
        // 最後一個月吃掉除不盡的尾數，確保區間加總＝原始盤損
        out[mm] = { amort: (k === slice.length - 1) ? total - per * (slice.length - 1) : per,
                    months: slice.length, srcYm: m, est: false };
      });
      lastPerMonth = per; lastSrc = m; from = i + 1;
    });

    // 最後一次盤點之後、尚未盤點的月份 → 用上一個完整區間的月均估算
    if (lastPerMonth != null) {
      for (let i = from; i < months.length; i++) {
        out[months[i]] = { amort: lastPerMonth, months: null, srcYm: lastSrc, est: true };
      }
    }
    return out;
  }

  // 淨損耗（元）＝ 壞品 − 攤提盤損 ＋ 現金短少。盤損負號存故「減」、現金短少正號存故「加」，三項都是損失。
  function netLoss(pn, a){
    if (!pn || !a || a.amort == null) return null;
    return num(pn.badGoodsCost) - a.amort + num(pn.cashDiff);
  }
  function lossRate(pn, a){
    const nl = netLoss(pn, a);
    return (nl != null && num(pn.netSales)) ? nl / num(pn.netSales) * 100 : null;
  }
  // 給 UI 的說明字串
  function note(a){
    if (!a || a.amort == null) return '尚無盤點紀錄，無法攤提';
    const amt = Math.round(a.amort).toLocaleString('en-US');
    return a.est
      ? `盤損攤提 ${amt}/月（估算：沿用 ${a.srcYm} 該次盤點的月均，本區間尚未盤點）`
      : `盤損攤提 ${amt}/月（${a.srcYm} 盤點結果分攤至 ${a.months} 個月）`;
  }

  global.PnlLoss = { build, netLoss, lossRate, note, isStocktake };
})(window);
