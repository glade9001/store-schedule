let currentUser=null, appConfig={}, curStore='', pnlCache={}, perfCache={}, amortCache={}, editMonth='';
const PERF_EXCLUDE=new Set(['2026-04']); // 2026/4 系統剛上線、薪資未完整結算，人事成本一律不列入分析
const START='2025-07';
const isAdminOwner=()=>['owner','admin'].includes(currentUser?.permission);
const canUse=()=>['manager','owner','admin'].includes(currentUser?.permission);
const pad=n=>String(n).padStart(2,'0');
const money=n=>Math.round(n||0).toLocaleString('en-US');
const showLoading=t=>{document.getElementById('loadingText').textContent=t||'載入中…';document.getElementById('loadingOverlay').classList.remove('hidden');};
const hideLoading=()=>document.getElementById('loadingOverlay').classList.add('hidden');
let _tt;
function toast(m){const t=document.getElementById('toast');t.textContent=m;t.classList.add('show');clearTimeout(_tt);_tt=setTimeout(()=>t.classList.remove('show'),2200);}
function monthLabel(m){const[y,mo]=m.split('-');return `${y} 年 ${parseInt(mo)} 月`;}
function prevYearMonth(m){const[y,mo]=m.split('-');return `${parseInt(y)-1}-${mo}`;}

// 產生月份清單：START ~ 上個月（新→舊）
function monthList(){
  const now=new Date();
  const end=new Date(now.getFullYear(),now.getMonth(),1); end.setMonth(end.getMonth()-1); // 上個月
  const out=[]; let[sy,sm]=START.split('-').map(Number);
  let y=end.getFullYear(),mo=end.getMonth()+1;
  while(y>sy||(y===sy&&mo>=sm)){ out.push(`${y}-${pad(mo)}`); mo--; if(mo<1){mo=12;y--;} }
  return out; // 新→舊
}

window.onload=async()=>{
  showLoading('驗證登入…');
  const saved=localStorage.getItem('currentUser')||sessionStorage.getItem('currentUser');
  if(!saved){location.replace('home.html');return;}
  try{currentUser=JSON.parse(saved);}catch(e){location.replace('home.html');return;}
  const fb=await new Promise(r=>{const u=firebase.auth().onAuthStateChanged(x=>{u();r(x);});});
  if(!fb){localStorage.removeItem('currentUser');location.replace('home.html');return;}
  if(!canUse()){toast('僅店長以上可用');setTimeout(()=>location.replace('home.html'),1200);return;}
  try{
    const s=await window.db.collection('settings').doc('globalConfig').get();
    if(s.exists)appConfig=s.data();
  }catch(e){}
  const stores=appConfig.stores||[];
  if(isAdminOwner()){
    const sel=document.getElementById('storeSel'); sel.style.display='block';
    sel.innerHTML=stores.map(s=>`<option value="${s}">${s}</option>`).join('');
    curStore=stores[0]||currentUser.store||'';
    sel.value=curStore;
  }else{
    curStore=currentUser.store||'';
  }
  await loadList();
  hideLoading();
};

async function onStoreChange(){
  curStore=document.getElementById('storeSel').value;
  // ⚠️ 期間(anaFrom/anaTo)是全域的：換門市不重設的話，會沿用上一家的月份範圍。
  //    例：美德最新只到 7 月 → 切到有 8 月的聯鑫，anaTo 仍停在 2026-07（在新店也存在故不會被修正）→ 8 月被濾掉不見。
  anaFrom=''; anaTo='';
  showLoading('載入…'); await loadList(); if(curTab==='analysis')renderAnalysis(); hideLoading();
}

async function loadList(){
  pnlCache={}; perfCache={}; amortCache={}; cmpData=null;
  try{
    const snap=await window.db.collection('stores').doc(curStore).collection('pnl').get();
    snap.forEach(d=>pnlCache[d.id]=d.data());
  }catch(e){ toast('讀取失敗：'+e.message); }
  try{
    const ps=await window.db.collection('stores').doc(curStore).collection('perfSnapshot').get();
    ps.forEach(d=>perfCache[d.id]=d.data());
  }catch(e){}
  // 盤損按盤點區間攤提（盤點 60~90 天一次），口徑見 pnl-loss.js
  amortCache=window.PnlLoss?window.PnlLoss.build(pnlCache):{};
  renderList();
}

function renderList(){
  const months=monthList();
  const wrap=document.getElementById('listWrap');
  if(!months.length){ wrap.innerHTML=`<div class="empty">目前沒有需要輸入的月份</div>`; return; }
  const todo=months.filter(m=>!pnlCache[m]);
  let html='';
  if(todo.length) html+=`<div class="sec-title">🔴 待輸入（${todo.length}）</div>`+
    months.filter(m=>!pnlCache[m]).map(m=>monCard(m,false)).join('');
  const done=months.filter(m=>pnlCache[m]);
  if(done.length) html+=`<div class="sec-title">✅ 已輸入（${done.length}）</div>`+
    done.map(m=>monCard(m,true)).join('');
  wrap.innerHTML=html;
}
function monCard(m,done){
  return `<div class="mon-card" onclick="openEdit('${m}')">
    <div class="mon-title">${monthLabel(m)}</div>
    <div class="mon-badge ${done?'b-done':'b-todo'}">${done?'✅ 已輸入':'🔴 待輸入'}</div>
    <div class="mon-arrow">›</div>
  </div>`;
}

function radioVal(name){ const el=document.querySelector(`input[name="${name}"]:checked`); return el?el.value:''; }
function onInvChange(){
  const t=radioVal('invType'); const inv=document.getElementById('fInv'); const amt=Math.abs(num('fInv')||0);
  inv.disabled=(t==='none'); if(t==='none') inv.value='';
  const p=document.getElementById('invPreview');
  if(t==='none'){ p.textContent='→ 本月無盤點'; p.style.color='#64748b'; }
  else if(t==='loss'){ p.textContent=`→ 本月盤損 ${money(amt)} 元（損失，計入損耗）`; p.style.color='#c5221f'; }
  else { p.textContent=`→ 本月盤盈 ${money(amt)} 元（收益，抵減損耗）`; p.style.color='#137333'; }
}
// 現金短溢＝照損益表原樣填（有負號就打負號）。刻意不做成「選狀態＋填正金額」——
// 店長對著損益表抄數字，多一層轉換反而容易搞錯。
// ⚠️ 但 input 不可以帶 inputmode="numeric"（2026-09-05 店長回報「打不出負號」）：
//    Android 會跳出純數字鍵盤，**沒有負號鍵**，溢餘那個月根本輸入不了。
//    拿掉 inputmode 讓 type=number 自己決定鍵盤（含負號），再配一顆 ± 鈕保底，
//    最後用下方即時預覽把「短少／溢餘」講成人話，讓店長自己核對正負號有沒有抄對。
function onCashChange(){
  const v=num('fCash'); const p=document.getElementById('cashPreview');
  if(v==null||v===0){ p.textContent='→ 本月無短溢'; p.style.color='#64748b'; }
  else if(v>0){ p.textContent=`→ 本月現金短少 ${money(v)} 元（費用，計入損耗）`; p.style.color='#c5221f'; }
  else { p.textContent=`→ 本月現金溢餘 ${money(-v)} 元（抵減成本）`; p.style.color='#137333'; }
}
// ± 鈕：某些 Android 鍵盤（或裝了第三方輸入法）在數字鍵盤上真的找不到負號時的保底。
function toggleCashSign(){
  const el=document.getElementById('fCash');
  const v=num('fCash');
  if(v==null||v===0){ el.focus(); return; }   // 空值沒有正負可切，直接讓他先打數字
  el.value=String(-v);
  onCashChange();
}

function openEdit(m){
  editMonth=m;
  document.getElementById('editTitle').textContent=`${monthLabel(m)}　${curStore}`;
  const d=pnlCache[m]||{};
  document.getElementById('fNetSales').value=d.netSales??'';
  document.getElementById('fGross').value=d.grossMargin??'';
  document.getElementById('fBad').value=d.badGoodsCost??'';
  document.getElementById('fElec').value=d.elecCost??'';
  document.getElementById('fMisc').value=d.miscCost??'';
  document.getElementById('fReward').value=d.operatingReward??'';
  // 盤點結果 radio
  const invT=(d.noStocktake||d.invResult==null)?'none':((d.invResult>0)?'gain':'loss');
  document.querySelector(`input[name="invType"][value="${invT}"]`).checked=true;
  document.getElementById('fInv').value=(invT==='none')?'':Math.abs(d.invResult);
  // 現金短溢：直接顯示含負號的數字（正=短少、負=溢餘），照損益表
  document.getElementById('fCash').value=(d.cashDiff==null)?'':d.cashDiff;
  onInvChange(); onCashChange();
  document.getElementById('cmpBox').innerHTML='';
  if(pnlCache[m]) viewMode(m); else editMode();   // 已輸入→檢視；待輸入→直接編輯
  document.getElementById('editOverlay').classList.add('show');
}
function viewMode(m){
  document.getElementById('formSection').style.display='none';
  document.getElementById('editBtn').style.display='block';
  document.getElementById('editSub').textContent='已輸入 · 點右上「編輯」可修改數字';
  showComparison(m);
}
function editMode(){
  document.getElementById('formSection').style.display='block';
  document.getElementById('editBtn').style.display='none';
  document.getElementById('editSub').textContent=pnlCache[editMonth]?'修改數字後重新儲存並比較':'請照公司損益表填入';
  document.getElementById('cmpBox').innerHTML='';
}
function switchToEdit(){ editMode(); }
function closeEdit(){ document.getElementById('editOverlay').classList.remove('show'); }

const num=id=>{const v=parseFloat(document.getElementById(id).value);return isNaN(v)?null:v;};

async function saveMonth(){
  const netSales=num('fNetSales'), grossMargin=num('fGross'), badGoodsCost=num('fBad'),
        elecCost=num('fElec'), miscCost=num('fMisc'), operatingReward=num('fReward');
  // 盤點結果：狀態選擇→符號(盤損=負/盤盈=正/無盤點=null)
  const invType=radioVal('invType');
  const noStocktake=(invType==='none');
  let invResult;
  if(noStocktake){ invResult=null; }
  else { const a=Math.abs(num('fInv')||0); invResult=(invType==='gain')?a:-a; }
  // 現金短溢：照損益表數字直接填(含負號，正=短少/負=溢餘)，未填視為 0
  let cashDiff=num('fCash'); if(cashDiff==null) cashDiff=0;
  // 必填檢查
  if([netSales,grossMargin,badGoodsCost,elecCost,miscCost,operatingReward].some(v=>v===null) || !invType){
    toast('請完整填寫營業淨額/毛利率/壞品/電費/雜支/經營報酬，並選盤點狀態'); return;
  }
  showLoading('儲存中…');
  const rec={ store:curStore, month:editMonth, netSales, grossMargin, badGoodsCost, elecCost, miscCost, cashDiff,
    operatingReward, invResult, noStocktake, badGoodsSubsidy: firebase.firestore.FieldValue.delete(),
    submittedBy:currentUser.empName||'', submittedByName:(currentUser.displayName||currentUser.empName||''),
    submittedAt:new Date().toISOString(), updatedAt:new Date().toISOString() };
  try{
    await window.db.collection('stores').doc(curStore).collection('pnl').doc(editMonth).set(rec,{merge:true});
    pnlCache[editMonth]=rec;
    // 新存的月份若比目前分析範圍還新 → 把範圍拉到它，否則剛輸入的月份在統計分析看不到
    if(anaTo && editMonth>anaTo) anaTo=editMonth;
    if(anaFrom && editMonth<anaFrom) anaFrom=editMonth;
    // 只有「有去年同期資料」才會通知全體（回填月份無同期→不發送）
    let hasPrev=false;
    try{ const ps=await window.db.collection('stores').doc(curStore).collection('pnl').doc(prevYearMonth(editMonth)).get(); hasPrev=ps.exists; }catch(e){}
    toast(hasPrev ? '✅ 已儲存，已通知全體店長' : '✅ 已儲存');
    renderList();
    viewMode(editMonth); // 存完切回檢視模式（只看績效，右上可再編輯）
  }catch(e){ toast('儲存失敗：'+e.message); }
  hideLoading();
}

// 指標比較 → HTML
function fmtInv(rec){
  if(!rec||rec.noStocktake||rec.invResult==null) return '本月無盤點';
  if(rec.invResult<0) return `盤損 ${money(-rec.invResult)}元`;
  if(rec.invResult>0) return `盤盈 ${money(rec.invResult)}元`;
  return '0 元';
}
async function showComparison(m){
  const cur=pnlCache[m];
  const pm=prevYearMonth(m);
  let prev=null;
  try{ const ps=await window.db.collection('stores').doc(curStore).collection('pnl').doc(pm).get(); if(ps.exists)prev=ps.data(); }catch(e){}
  const rows=[];
  const upDown=(curV,prevV,unit,goodUp,fmt)=>{
    if(prev==null||prevV==null) return `<div class="cmp-delta neu">（同期無資料）</div>`;
    const d=curV-prevV, abs=fmt(Math.abs(d));
    const better = goodUp ? d>=0 : d<=0;
    const word = goodUp ? (d>=0?'成長':'衰退') : (d<=0?'減少':'增加');
    const mark = better?'✅':'❌';
    return `<div class="cmp-delta ${better?'up':'down'}">（較同期${word} ${mark} ${abs}${unit}）</div>`;
  };
  const neutralDelta=(curV,prevV,unit,fmt)=>{
    if(prev==null||prevV==null) return `<div class="cmp-delta neu">（同期無資料）</div>`;
    const d=curV-prevV;
    const word=d>=0?'增加':'減少';
    return `<div class="cmp-delta neu">（較同期${word} ${fmt(Math.abs(d))}${unit}）</div>`;
  };
  rows.push(`<div class="cmp-row"><div class="cmp-metric">營業淨額 ${money(cur.netSales)}</div>${upDown(cur.netSales,prev?.netSales,'元',true,money)}</div>`);
  rows.push(`<div class="cmp-row"><div class="cmp-metric">壞品 ${money(cur.badGoodsCost)}元</div>${upDown(cur.badGoodsCost,prev?.badGoodsCost,'元',false,money)}</div>`);
  // 盤損
  let invCmp;
  if(prev==null||prev.noStocktake||prev.invResult==null) invCmp=`<div class="cmp-delta neu">（同期無盤點）</div>`;
  else if(cur.noStocktake||cur.invResult==null) invCmp=`<div class="cmp-delta neu">（本月無盤點）</div>`;
  else invCmp=upDown(cur.invResult,prev.invResult,'元',true,money);
  rows.push(`<div class="cmp-row"><div class="cmp-metric">${fmtInv(cur)}</div>${invCmp}</div>`);
  rows.push(`<div class="cmp-row"><div class="cmp-metric">毛利 ${cur.grossMargin}%</div>${upDown(cur.grossMargin,prev?.grossMargin,'%',true,v=>v.toFixed(2))}</div>`);
  rows.push(`<div class="cmp-row"><div class="cmp-metric">門市電費 ${money(cur.elecCost)}元</div>${upDown(cur.elecCost,prev?.elecCost,'元',false,money)}</div>`);
  rows.push(`<div class="cmp-row"><div class="cmp-metric">雜支 ${money(cur.miscCost)}元</div>${upDown(cur.miscCost,prev?.miscCost,'元',false,money)}</div>`);
  rows.push(`<div class="cmp-row"><div class="cmp-metric">現金短少 ${money(cur.cashDiff)}元${cur.cashDiff>0?'（短少）':cur.cashDiff<0?'（溢餘）':''}</div>${neutralDelta(cur.cashDiff,prev?.cashDiff,'元',money)}</div>`);
  rows.push(`<div class="cmp-row"><div class="cmp-metric">經營報酬 ${money(cur.operatingReward)}元</div>${upDown(cur.operatingReward,prev?.operatingReward,'元',true,money)}</div>`);
  document.getElementById('cmpBox').innerHTML=`<div class="cmp"><div class="cmp-title">${curStore} ${m.split('-')[0]}年${parseInt(m.split('-')[1])}月 經營績效</div>${rows.join('')}</div>`;
}

// ===== 📊 統計分析（Phase 1：損益指標逐月趨勢）=====
let curTab='input', anaFrom='', anaTo='';
function switchTab(t){
  curTab=t;
  document.getElementById('tab-input').classList.toggle('active',t==='input');
  document.getElementById('tab-analysis').classList.toggle('active',t==='analysis');
  document.getElementById('tabInput').style.display=t==='input'?'block':'none';
  document.getElementById('tabAnalysis').style.display=t==='analysis'?'block':'none';
  if(t==='analysis')renderAnalysis();
}
// 點值精簡格式：萬/整數/一位小數
function ptFmt(v){ if(v==null)return''; const a=Math.abs(v); if(a>=10000)return (v/10000).toFixed(1)+'萬'; if(Number.isInteger(v))return String(v); return v.toFixed(1); }
// Y 軸範圍：不再貼著資料上下緣縮放（毛利率差 1pt 也會撐滿整張圖、看起來像大起大落）。
// 範圍至少要有 minSpan（絕對值，例：毛利率 8pt）或 minSpanPct（平均值的百分比，例：營收 40%），
// 資料本身變動更大時才照資料撐開；全部 ≥0 的指標下緣不低於 0。
function chartRange(vals,opt){
  const dMin=Math.min(...vals), dMax=Math.max(...vals);
  let min=dMin, max=dMax;
  const mean=vals.reduce((s,v)=>s+Math.abs(v),0)/vals.length;
  const need=Math.max(opt.minSpan||0,(opt.minSpanPct||0)*mean/100);
  if(max-min<need){ const c=(max+min)/2; min=c-need/2; max=c+need/2; }
  if(min===max){ min-=Math.abs(min||1)*0.1; max+=Math.abs(max||1)*0.1; }
  if(dMin>=0 && min<0){ max-=min; min=0; }
  return [min,max];
}
// 去年同月差異文字：金額類用 %，比率類（opt.yoy='pp'）用百分點
function yoyText(cur,prev,opt){
  if(cur==null||prev==null) return '';
  if(opt.yoy==='pp'){ const d=cur-prev; return (d>=0?'+':'')+d.toFixed(1)+'pt'; }
  if(!prev) return '';
  const d=(cur-prev)/Math.abs(prev)*100; return (d>=0?'+':'')+d.toFixed(1)+'%';
}
// 單店趨勢折線：實線＝當月數字，灰虛線＝去年同月（同一個 X 位置）→ 一眼分得出是季節性還是真的變了。
// points=[{label,value,prev,detail}]；opt={color,fmt,minSpan,minSpanPct,yoy}
function lineChart(points,opt){
  opt=opt||{};
  const esc=s=>String(s==null?'':s).replace(/['"\\<>]/g,'');
  const fmtV=v=>opt.fmt?opt.fmt(v):ptFmt(v);
  // 去掉前後端連續空值（前期沒資料就不留空白、不用往左滑找）
  let a=0,b=points.length-1;
  while(a<=b && points[a].value==null)a++;
  while(b>=a && points[b].value==null)b--;
  if(a>b)return '<div style="font-size:12px;color:var(--text-muted);">尚無資料</div>';
  points=points.slice(a,b+1);
  const vals=points.map(p=>p.value).filter(v=>v!=null);
  const pvals=points.map(p=>p.prev).filter(v=>v!=null);
  const hasPrev=pvals.length>0;
  const n=points.length, W=Math.max(340,n*58+80), H=192, pl=38,pr=42,pt=28,pb=28, iw=W-pl-pr, ih=H-pt-pb;
  const [min,max]=chartRange(vals.concat(pvals),opt);
  const X=i=>pl+(n<=1?iw/2:i/(n-1)*iw);
  const Y=v=>pt+ih-(v-min)/(max-min)*ih;
  // Y 軸刻度線（3 等分，淺灰）
  let grid='';
  for(let t=0;t<=3;t++){const gv=min+(max-min)*t/3, gy=Y(gv);
    grid+=`<line x1="${pl}" y1="${gy.toFixed(1)}" x2="${(W-pr).toFixed(1)}" y2="${gy.toFixed(1)}" stroke="#eef1f4" stroke-width="1"/>`+
      `<text x="${(pl-5)}" y="${(gy+3).toFixed(1)}" font-size="8" fill="#bbb" text-anchor="end">${ptFmt(gv)}</text>`;}
  // 平均線（虛線）＋左上標示
  const avg=vals.reduce((s,v)=>s+v,0)/vals.length, avgY=Y(avg);
  const avgLine=`<line x1="${pl}" y1="${avgY.toFixed(1)}" x2="${(W-pr).toFixed(1)}" y2="${avgY.toFixed(1)}" stroke="${opt.color}" stroke-width="1" stroke-dasharray="4 3" opacity=".45"/>`+
    `<text x="${(pl+2)}" y="${(avgY-4).toFixed(1)}" font-size="8.5" fill="${opt.color}" text-anchor="start" opacity=".9" font-weight="700">均 ${fmtV(avg)}</text>`;
  // 去年同月：灰色虛線，中間缺月就斷開（不硬連）
  let prevPath='',prevDots='',pen=false;
  points.forEach((p,i)=>{ if(p.prev==null){pen=false;return;} const x=X(i),y=Y(p.prev);
    prevPath+=(pen?' L':' M')+x.toFixed(1)+' '+y.toFixed(1); pen=true;
    prevDots+=`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2" fill="#94a3b8"/>`; });
  let path='',dots='',taps='',vlabels='',labels='';
  points.forEach((p,i)=>{if(p.value==null)return;const x=X(i),y=Y(p.value);
    path+=(path?' L':'M')+x.toFixed(1)+' '+y.toFixed(1);
    dots+=`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.8" fill="${opt.color}"/>`;
    const yo=p.prev!=null?`去年同月 ${fmtV(p.prev)}（${yoyText(p.value,p.prev,opt)||'—'}）`:(hasPrev?'去年同月 無資料':'');
    const det=[yo,p.detail||''].filter(Boolean).join('｜');
    taps+=`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="14" fill="transparent" style="cursor:pointer" onclick="showPt('${esc(p.label)}','${esc(fmtV(p.value))}','${esc(det)}')"/>`;
    vlabels+=`<text x="${x.toFixed(1)}" y="${(y-6).toFixed(1)}" font-size="9" fill="${opt.color}" text-anchor="middle" font-weight="800">${ptFmt(p.value)}</text>`;});
  points.forEach((p,i)=>{labels+=`<text x="${X(i).toFixed(1)}" y="${H-8}" font-size="9" fill="#999" text-anchor="middle">${p.label}</text>`;});
  // 圖例放在捲動區外面：圖表一打開就捲到最右邊（看最新月份），畫在 SVG 左上角的圖例會被捲走
  const legend=hasPrev?`<div class="pf-legend"><span><i style="border-top:2.5px solid ${opt.color}"></i>當月</span><span><i style="border-top:2px dashed #94a3b8"></i>去年同月</span></div>`:'';
  return `${legend}<div class="chart-scroll" style="overflow-x:auto;"><svg viewBox="0 0 ${W} ${H}" style="min-width:${W}px;height:auto;">
    ${grid}${avgLine}<path d="${prevPath}" fill="none" stroke="#94a3b8" stroke-width="1.6" stroke-dasharray="4 3"/>${prevDots}<path d="${path}" fill="none" stroke="${opt.color}" stroke-width="2.2"/>${dots}${taps}${vlabels}${labels}</svg></div>`;
}
// 淨損耗堆疊長條：壞品／盤損（攤提）／現金短少 三段疊起來，一眼看出損耗從哪裡來。
// 盤盈、現金溢收是負的損耗，不畫進長條（疊不上去），但長條頂端的數字＝真正的淨損耗（已扣掉）。
// 灰色短橫線＝去年同月淨損耗。盤損是估算的月份（尚未盤點）那段畫淡色並標「估」。
// rows=[{label,bad,inv,cash,total,prev,est,note}]
const LOSS_PARTS=[{k:'bad',t:'壞品',c:'#c5221f'},{k:'inv',t:'盤損',c:'#f59e0b'},{k:'cash',t:'現金短少',c:'#7c3aed'}];
function lossBarChart(rows){
  const esc=s=>String(s==null?'':s).replace(/['"\\<>]/g,'');
  let a=0,b=rows.length-1;
  while(a<=b && rows[a].total==null)a++;
  while(b>=a && rows[b].total==null)b--;
  if(a>b)return '<div style="font-size:12px;color:var(--text-muted);">尚無資料</div>';
  rows=rows.slice(a,b+1);
  const pos=v=>(v!=null&&v>0)?v:0;
  const top=Math.max(...rows.map(r=>Math.max(LOSS_PARTS.reduce((s,p)=>s+pos(r[p.k]),0), r.total||0, r.prev||0)),1)*1.15;
  const n=rows.length, W=Math.max(340,n*58+80), H=196, pl=38,pr=42,pt=24,pb=28, iw=W-pl-pr, ih=H-pt-pb;
  const step=iw/n, bw=Math.min(30,step*0.56);
  const X=i=>pl+step*(i+0.5), Y=v=>pt+ih-v/top*ih;
  let grid='';
  for(let t=0;t<=3;t++){const gv=top*t/3, gy=Y(gv);
    grid+=`<line x1="${pl}" y1="${gy.toFixed(1)}" x2="${(W-pr).toFixed(1)}" y2="${gy.toFixed(1)}" stroke="#eef1f4" stroke-width="1"/>`+
      `<text x="${(pl-5)}" y="${(gy+3).toFixed(1)}" font-size="8" fill="#bbb" text-anchor="end">${ptFmt(gv)}</text>`;}
  let bars='',labels='';
  rows.forEach((r,i)=>{
    const x=X(i)-bw/2; let acc=0;
    if(r.total!=null){
      LOSS_PARTS.forEach(p=>{ const v=pos(r[p.k]); if(!v) return;
        const y1=Y(acc+v), h=Y(acc)-y1;
        bars+=`<rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${p.c}" opacity="${p.k==='inv'&&r.est?0.4:0.9}"/>`;
        acc+=v; });
      bars+=`<text x="${X(i).toFixed(1)}" y="${(Y(Math.max(acc,r.total))-5).toFixed(1)}" font-size="9" fill="#b91c1c" text-anchor="middle" font-weight="800">${ptFmt(r.total)}${r.est?'·估':''}</text>`;
      const det=LOSS_PARTS.map(p=>`${p.t} ${r[p.k]==null?'—':money(r[p.k])}`).join('｜')
        +(r.prev!=null?`｜去年同月 ${money(r.prev)}（${yoyText(r.total,r.prev,{})||'—'}）`:'｜去年同月 無資料')+(r.note?'｜'+r.note:'');
      bars+=`<rect x="${(X(i)-step/2).toFixed(1)}" y="${pt}" width="${step.toFixed(1)}" height="${ih}" fill="transparent" style="cursor:pointer" onclick="showPt('${esc(r.label)} 淨損耗','${esc(money(r.total))}','${esc(det)}')"/>`;
    }
    if(r.prev!=null){ const py=Y(pos(r.prev)); bars+=`<line x1="${(X(i)-bw/2-4).toFixed(1)}" y1="${py.toFixed(1)}" x2="${(X(i)+bw/2+4).toFixed(1)}" y2="${py.toFixed(1)}" stroke="#64748b" stroke-width="2" stroke-dasharray="3 2"/>`; }
    labels+=`<text x="${X(i).toFixed(1)}" y="${H-8}" font-size="9" fill="#999" text-anchor="middle">${r.label}</text>`;
  });
  const legend=`<div class="pf-legend">${LOSS_PARTS.map(p=>`<span><b style="background:${p.c}"></b>${p.t}</span>`).join('')}<span><i style="border-top:2px dashed #64748b"></i>去年同月</span></div>`;
  return `${legend}<div class="chart-scroll" style="overflow-x:auto;"><svg viewBox="0 0 ${W} ${H}" style="min-width:${W}px;height:auto;">${grid}${bars}${labels}</svg></div>`;
}
/** 圖表畫完捲到最右邊：看的永遠是最新月份（不加的話每次都要自己往右滑） */
function pfScrollChartsToEnd(root){
  requestAnimationFrame(function(){
    (root||document).querySelectorAll('.chart-scroll').forEach(function(e){ e.scrollLeft = e.scrollWidth; });
  });
}
function showPt(title,val,detail){
  const el=document.getElementById('ptPop'); if(!el)return;
  el.innerHTML=`<div style="font-weight:900;font-size:14px;">${title}</div>`+
    `<div style="font-size:17px;font-weight:900;color:var(--primary);margin:2px 0 4px;">${val}</div>`+
    (detail?`<div style="font-size:12px;color:var(--text-muted);line-height:1.7;">${String(detail).split('｜').join('<br>')}</div>`:'');
  el.style.display='block';
  clearTimeout(window._ptT); window._ptT=setTimeout(()=>{el.style.display='none';},4500);
}
// 多線圖（三店同圖比較）：series=[{name,color,values:[...]}]，values 對齊 months
function multiLineChart(months, series, opt){
  opt=opt||{};
  const esc=s=>String(s==null?'':s).replace(/['"\\<>]/g,'');
  const fmtV=v=>opt.fmt?opt.fmt(v):ptFmt(v);
  const mlbl=m=>{const p=String(m).split('-');return `${p[0].slice(2)}/${parseInt(p[1])}`;};
  const hasAny=i=>series.some(s=>s.values[i]!=null);
  let a=0,b=months.length-1; while(a<=b&&!hasAny(a))a++; while(b>=a&&!hasAny(b))b--;
  if(a>b)return '<div style="font-size:12px;color:var(--text-muted);">此期間尚無資料</div>';
  months=months.slice(a,b+1); series=series.map(s=>({name:s.name,color:s.color,values:s.values.slice(a,b+1)}));
  const allV=[]; series.forEach(s=>s.values.forEach(v=>{if(v!=null)allV.push(v);}));
  if(!allV.length)return '<div style="font-size:12px;color:var(--text-muted);">此期間尚無資料</div>';
  const n=months.length, W=Math.max(340,n*58+80), H=214, pl=38,pr=42,pt=42,pb=28, iw=W-pl-pr, ih=H-pt-pb;
  let min=Math.min(...allV),max=Math.max(...allV); if(min===max){min=min-Math.abs(min||1)*0.1;max=max+Math.abs(max||1)*0.1;}
  const X=i=>pl+(n<=1?iw/2:i/(n-1)*iw), Y=v=>pt+ih-(v-min)/(max-min)*ih;
  let grid='';
  for(let t=0;t<=3;t++){const gv=min+(max-min)*t/3, gy=Y(gv);
    grid+=`<line x1="${pl}" y1="${gy.toFixed(1)}" x2="${(W-pr).toFixed(1)}" y2="${gy.toFixed(1)}" stroke="#eef1f4" stroke-width="1"/>`+
      `<text x="${(pl-5)}" y="${(gy+3).toFixed(1)}" font-size="8" fill="#bbb" text-anchor="end">${ptFmt(gv)}</text>`;}
  let body='';
  series.forEach(s=>{let path='',dots='',taps='';
    s.values.forEach((v,i)=>{if(v==null)return;const x=X(i),y=Y(v);
      path+=(path?' L':'M')+x.toFixed(1)+' '+y.toFixed(1);
      dots+=`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.6" fill="${s.color}"/>`;
      taps+=`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="12" fill="transparent" style="cursor:pointer" onclick="showPt('${esc(s.name)} · ${esc(mlbl(months[i]))}','${esc(fmtV(v))}','')"/>`;});
    body+=`<path d="${path}" fill="none" stroke="${s.color}" stroke-width="${s.dash?2:2.2}"${s.dash?' stroke-dasharray="6 4"':''}/>${dots}${taps}`;});
  let legend=''; series.forEach((s,i)=>{const lx=pl+i*96;legend+=`<circle cx="${lx}" cy="18" r="4.5" fill="${s.color}"/><text x="${lx+9}" y="22" font-size="11" fill="#333" font-weight="800">${esc(s.name)}</text>`;});
  let labels=''; months.forEach((m,i)=>{labels+=`<text x="${X(i).toFixed(1)}" y="${H-8}" font-size="9" fill="#999" text-anchor="middle">${mlbl(m)}</text>`;});
  return `<div class="chart-scroll" style="overflow-x:auto;"><svg viewBox="0 0 ${W} ${H}" style="min-width:${W}px;height:auto;">${grid}${legend}${body}${labels}</svg></div>`;
}
async function renderStoreTrend(){
  const box=document.getElementById('storeTrendBox'); if(!box)return;
  await loadAllForCompare();
  const sts=(appConfig.stores||[]).filter(s=>s!=='人力支援');
  const mset=new Set();
  sts.forEach(s=>Object.keys((cmpData[s]||{}).pnl||{}).forEach(k=>{if(/^\d{4}-\d{2}$/.test(k)&&k>=anaFrom&&k<=anaTo)mset.add(k);}));
  // 人事效率類指標也把有 perf 的月份納入(即使 pnl 缺，仍可能想看)；但目前指標多需 pnl，故以 pnl 月為主
  const months=[...mset].sort();
  if(!months.length){box.innerHTML='<div style="font-size:12px;color:var(--text-muted);">此期間尚無資料</div>';return;}
  const M=METRICS[cmpMetric]||METRICS.netSales;
  const series=sts.map(s=>({name:s,color:STORE_COLORS[s]||'#888',values:months.map(m=>{
    const pn=(cmpData[s]||{}).pnl[m];
    const pf=PERF_EXCLUDE.has(m)?null:(cmpData[s]||{}).perf[m];
    return M.get(pn, pf, ((cmpData[s]||{}).amort||{})[m]);
  })}));
  // 聚合線：門市餘裕用「總計」，其餘用「平均」
  const isSum=M.agg==='sum';
  const aggVals=months.map((m,i)=>{const vs=series.map(s=>s.values[i]).filter(v=>v!=null);
    if(!vs.length)return null; const sum=vs.reduce((a,b)=>a+b,0); return isSum?sum:sum/vs.length;});
  series.push({name:isSum?'總計':'平均',color:'#94a3b8',dash:true,values:aggVals});
  box.innerHTML=multiLineChart(months, series, {fmt:M.fmt})
    +`<div style="font-size:11px;color:var(--text-muted);margin-top:6px;">點線上的點看該店該月數值。人事類指標 2026/5 起才有（薪資系統上線時間），2026/4 不列入。</div>`;
  pfScrollChartsToEnd(box);
}
// ===== 近月實績表（指標當列、月份當欄，左右各一個年度平均當錨點）=====
// 排法參考連鎖體系的單店月報：中間看近況、兩側看基準，同比差異獨立成列並標紅綠。
// ⚠️ 人事類指標 2026/5 起才有（薪資系統上線時間），去年同期一律顯示「—」，不可填 0
//    （0 是合法金額，會被當成「沒有變化」靜靜吃掉，見歷史資料不可變鐵則）。
function pfRecentTable(months){
  if(!months || !months.length) return '';
  const lbl=m=>{const p=m.split('-');return `${p[0].slice(2)}/${parseInt(p[1])}`;};
  const cols=months.slice(-3);
  const yr=+cols[cols.length-1].slice(0,4), pyr=yr-1;
  const pn=m=>pnlCache[m]||null;
  const pf=m=>(perfCache[m]&&!PERF_EXCLUDE.has(m))?perfCache[m]:null;
  // ⚠️ 兩個年度平均的涵蓋月份不一樣（例：2025 只有 7~12 月、2026 有 1~8 月），
  //    直接相減會被季節性汙染 → 顯示用各自的全年平均，但「同比差異」只取兩年共有的月份重算。
  const monthsOf=y=>Object.keys(pnlCache).filter(m=>+m.slice(0,4)===y).map(m=>m.slice(5));
  const lastSet=new Set(monthsOf(pyr));
  const common=new Set(monthsOf(yr).filter(mm=>lastSet.has(mm)));
  const avgY=(y,pick,only)=>{
    const vs=Object.keys(pnlCache)
      .filter(m=>+m.slice(0,4)===y && (!only || only.has(m.slice(5))))
      .map(pick).filter(v=>v!=null);
    return vs.length ? vs.reduce((a,b)=>a+b,0)/vs.length : null;
  };
  const cover=y=>{const ms=monthsOf(y).sort(); return ms.length?`${parseInt(ms[0])}–${parseInt(ms[ms.length-1])}月`:'';};
  const ROWS=[
    {g:'業績',c:'#0f7b3e'},
    {t:'營業淨額（元）',f:money,p:m=>pn(m)?pn(m).netSales:null,yoy:'pct',up:1},
    {t:'毛利率（%）',f:v=>v.toFixed(1),p:m=>pn(m)?pn(m).grossMargin:null,yoy:'pp',up:1},
    {t:'經營報酬（元）',f:money,p:m=>pn(m)?pn(m).operatingReward:null,yoy:'pct',up:1},
    {g:'損耗',c:'#b3261e'},
    {t:'壞品額（元）',f:money,p:m=>pn(m)?pn(m).badGoodsCost:null},
    {t:'壞品率（%）',f:v=>v.toFixed(2),p:m=>(pn(m)&&pn(m).netSales)?pn(m).badGoodsCost/pn(m).netSales*100:null,yoy:'pp',up:0},
    {t:'現金短少（元）',f:money,p:m=>pn(m)?pn(m).cashDiff:null},
    {t:'淨損耗（元）',f:money,p:m=>window.PnlLoss?window.PnlLoss.netLoss(pn(m),amortCache[m]):null,yoy:'pct',up:0},
    {g:'費用',c:'#0b5aa8'},
    {t:'門市電費（元）',f:money,p:m=>pn(m)?pn(m).elecCost:null},
    {t:'雜支（元）',f:money,p:m=>pn(m)?pn(m).miscCost:null},
    {g:'人事（2026/5 起才有資料）',c:'#6d28d9'},
    {t:'人事費用（元）',f:money,p:m=>pf(m)?pf(m).laborCost:null,noYoy:1},
    {t:'人事費率（%）',f:v=>v.toFixed(1),p:m=>(pf(m)&&pn(m)&&pn(m).netSales)?pf(m).laborCost/pn(m).netSales*100:null,noYoy:1},
    {t:'每工時營收（元/h）',f:v=>money(v),p:m=>(pf(m)&&pn(m)&&pf(m).totalHours)?pn(m).netSales/pf(m).totalHours:null,noYoy:1},
    {t:'門市餘裕（元）',f:money,p:m=>(pf(m)&&pn(m))?pn(m).operatingReward-pf(m).laborCost:null,noYoy:1},
  ];
  const em='<td class="rt-v rt-em">—</td>';
  let body='';
  ROWS.forEach(r=>{
    if(r.g){ body+=`<tr class="rt-g" style="background:${r.c};"><td colspan="${cols.length+3}">${r.g}</td></tr>`; return; }
    const pa=avgY(pyr,r.p), ca=avgY(yr,r.p);
    const cell=v=>v==null?em:`<td class="rt-v">${r.f(v)}</td>`;
    body+=`<tr><td class="rt-t">${r.t}</td>${cell(pa)}${cols.map(m=>cell(r.p(m))).join('')}${cell(ca)}</tr>`;
    if(r.noYoy){
      body+=`<tr class="rt-d"><td class="rt-t">　↳ 同比差異</td>${em}${cols.map(()=>em).join('')}${em}</tr>`;
      return;
    }
    if(!r.yoy) return;
    const diff=(cur,base)=>{
      if(cur==null||base==null) return em;
      const d = r.yoy==='pp' ? (cur-base) : (base===0?null:(cur-base)/Math.abs(base)*100);
      if(d==null) return em;
      const better = r.up ? d>=0 : d<=0;
      const txt = (d>=0?'+':'') + d.toFixed(1) + (r.yoy==='pp'?'pp':'%');
      return `<td class="rt-v" style="color:${better?'#0f7b3e':'#b3261e'};font-weight:800;">${txt}</td>`;
    };
    body+=`<tr class="rt-d"><td class="rt-t">　↳ 同比差異</td>${em}`
      + cols.map(m=>diff(r.p(m), r.p(prevYearMonth(m)))).join('')
      + diff(avgY(yr,r.p,common), avgY(pyr,r.p,common)) + '</tr>';
  });
  const head=`<tr><th class="rt-t">指標</th><th class="rt-v">${pyr}年平均<br><span class="rt-cov">${cover(pyr)}</span></th>`
    + cols.map(m=>`<th class="rt-v">${lbl(m)}</th>`).join('')
    + `<th class="rt-v">${yr}年平均<br><span class="rt-cov">${cover(yr)}</span></th></tr>`;
  // 表格資訊密度高，預設收起來；要看再點開（原生 <details>，不必寫 JS）
  return `<details class="chart-card rt-fold"><summary class="chart-title">📋 近月實績（${lbl(cols[0])}～${lbl(cols[cols.length-1])}）</summary>
    <div class="chart-scroll" style="overflow-x:auto;"><table class="rt">${head}${body}</table></div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:8px;line-height:1.7;">
      兩側是年度平均（當基準），中間是最近三個月。「同比差異」＝跟<b>去年同月</b>比；年度平均欄位比的是<b>兩個年度的平均</b>。<br>
      綠＝比去年好、紅＝比去年差。人事類 2026/5 起才有資料，去年同期不存在所以顯示「—」。<br>
      兩個年度涵蓋的月份不同（見欄位下方小字），所以<b>年度平均那欄的同比只取兩年共有的月份</b>重算，避免被季節性影響。
    </div></details>`;
}

// ===== 🔎 本月重點：跟去年同月比，挑出進步最多、退步最多的一項（不用自己一張張圖找）=====
// 不同單位要排在一起比，一律換成「相對變化 %」排序；毛利率顯示時用百分點。
// 現金短少會正負翻轉、金額又小，相對變化沒意義 → 不列入。金額類去年不到 3,000 元、或差不到 3,000 元的也跳過（雜支去年 380 元→今年 5,185 元會變成「+1264%」，不算重點）。
function pfHighlights(m){
  const L=pnlCache[m]; if(!L) return '';
  const pm=prevYearMonth(m), P=pnlCache[pm];
  const num=(d,k)=>(d&&d[k]!=null&&d[k]!=='')?+d[k]:null;
  const PL=window.PnlLoss;
  const cand=[
    {t:'營業淨額',cur:num(L,'netSales'),prev:num(P,'netSales'),up:1},
    {t:'毛利率',cur:num(L,'grossMargin'),prev:num(P,'grossMargin'),up:1,pp:1},
    {t:'經營報酬',cur:num(L,'operatingReward'),prev:num(P,'operatingReward'),up:1},
    {t:'淨損耗',cur:PL?PL.netLoss(L,amortCache[m]):null,prev:PL?PL.netLoss(P,amortCache[pm]):null,up:0,
      tail:(amortCache[m]&&amortCache[m].est)?'，盤損為估算':''},
    {t:'壞品',cur:num(L,'badGoodsCost'),prev:num(P,'badGoodsCost'),up:0},
    {t:'門市電費',cur:num(L,'elecCost'),prev:num(P,'elecCost'),up:0},
    {t:'雜支',cur:num(L,'miscCost'),prev:num(P,'miscCost'),up:0},
  ].filter(c=>c.cur!=null&&c.prev!=null&&c.prev!==0&&(c.pp||(Math.abs(c.prev)>=3000&&Math.abs(c.cur-c.prev)>=3000)));
  cand.forEach(c=>{ c.rel=(c.cur-c.prev)/Math.abs(c.prev)*100; c.good=c.up?c.rel:-c.rel;
    c.txt=c.pp?`${c.cur.toFixed(1)}%（去年 ${c.prev.toFixed(1)}%，${c.cur>=c.prev?'+':''}${(c.cur-c.prev).toFixed(1)}pt${c.tail||''}）`
      :`${money(c.cur)} 元（${c.rel>=0?'+':''}${c.rel.toFixed(1)}%${c.tail||''}）`; });
  const lines=[];
  if(!cand.length) lines.push('<div class="hl-row">去年同月沒有資料，還不能比較。</div>');
  else{
    const best=cand.reduce((a,b)=>b.good>a.good?b:a), worst=cand.reduce((a,b)=>b.good<a.good?b:a);
    lines.push(best.good>0?`<div class="hl-row"><span class="hl-ic">✅</span>進步最多：<b>${best.t}</b> ${best.txt}</div>`:'<div class="hl-row"><span class="hl-ic">➖</span>沒有比去年進步的項目</div>');
    lines.push(worst.good<0?`<div class="hl-row"><span class="hl-ic">⚠️</span>退步最多：<b>${worst.t}</b> ${worst.txt}</div>`:'<div class="hl-row"><span class="hl-ic">👍</span>沒有比去年退步的項目</div>');
  }
  // 人事費率去年沒有資料（2026/5 起才有）→ 跟上月比
  const lr=x=>(perfCache[x]&&!PERF_EXCLUDE.has(x)&&num(pnlCache[x],'netSales'))?perfCache[x].laborCost/num(pnlCache[x],'netSales')*100:null;
  const [y,mo]=m.split('-').map(Number), lm=`${mo===1?y-1:y}-${pad(mo===1?12:mo-1)}`;
  const r=lr(m), rp=lr(lm);
  if(r!=null) lines.push(`<div class="hl-row"><span class="hl-ic">📐</span>人事費率 <b>${r.toFixed(1)}%</b>${rp!=null?`（上月 ${rp.toFixed(1)}%，${r<=rp?'下降':'上升'} ${Math.abs(r-rp).toFixed(1)}pt）`:''}</div>`);
  return `<div class="chart-card hl"><div class="chart-title">🔎 本月重點 <span class="hl-sub">${monthLabel(m)}・跟去年同月比</span></div>${lines.join('')}</div>`;
}

// ===== 🕐 出勤紀律（單店）：口徑同加盟主儀表板（attendance-discipline.js）=====
const ATT_START='2026-08';   // 打卡系統的正式資料從 2026/8 起
const DISC_K=[
  {k:'missRate',t:'缺卡率',up:0},{k:'reqRate',t:'補登率',up:0},{k:'lateRate',t:'遲到率',up:0},{k:'appRate',t:'App 打卡率',up:1}];
let discCache={}, discKey='appRate', discMonths=[];
function ymNext(m){const[y,mo]=m.split('-').map(Number);return mo===12?`${y+1}-01`:`${y}-${pad(mo+1)}`;}
function ymNow(){const d=new Date();return `${d.getFullYear()}-${pad(d.getMonth()+1)}`;}
async function renderDisc(){
  const box=document.getElementById('discBox'); if(!box) return;
  const store=curStore, now=ymNow();
  // 期間跟著上方的選擇；選到最新一個損益月時，一併帶出還沒有損益的月份（含本月進行中）
  const allM=Object.keys(pnlCache).sort();
  const end=(anaTo===allM[allM.length-1])?now:anaTo;
  const months=[]; for(let m=anaFrom>ATT_START?anaFrom:ATT_START; m<=end; m=ymNext(m)) months.push(m);
  await Promise.all(months.map(async ym=>{ const k=store+'|'+ym; if(discCache[k]!==undefined) return;
    try{ discCache[k]=await window.AttDisc.month(store,ym); }catch(e){ discCache[k]=null; } }));
  if(store!==curStore) return;   // 讀取途中換了門市
  discMonths=months; drawDisc();
}
function drawDisc(){
  const box=document.getElementById('discBox'); if(!box) return;
  const store=curStore, now=ymNow(), months=discMonths;
  const lbl=m=>{const p=m.split('-');return `${p[0].slice(2)}/${parseInt(p[1])}`;};
  const D_=m=>discCache[store+'|'+m]||null;
  const got=months.filter(D_);
  const head='<div class="chart-title">🕐 出勤紀律</div>';
  if(!got.length){ box.innerHTML=head+'<div style="font-size:12px;color:var(--text-muted);">此期間沒有打卡資料（打卡系統 2026/8 起）</div>'; return; }
  // 指標卡看最近一個「完整」月份；本月還在進行中，數字會變
  const full=got.filter(m=>m<now), cur=full.length?full[full.length-1]:got[got.length-1];
  const D=D_(cur), Pd=D_(got[got.indexOf(cur)-1]||'');
  const tiles=DISC_K.map(c=>{ const v=D[c.k], pv=Pd?Pd[c.k]:null;
    let delta='<div class="kpi-delta neu">上月無資料</div>';
    if(v!=null&&pv!=null){ const d=Math.round((v-pv)*10)/10, better=c.up?d>=0:d<=0;
      delta=d===0?'<div class="kpi-delta neu">與上月持平</div>':`<div class="kpi-delta ${better?'up':'down'}">${better?'▲':'▼'} 上月 ${pv}%</div>`; }
    return `<div class="kpi"><div class="kpi-label">${c.t}</div><div class="kpi-val">${v==null?'—':v+'%'}</div>${delta}</div>`; }).join('');
  const col=DISC_K.find(c=>c.k===discKey)||DISC_K[3];
  const sel=`<select onchange="discKey=this.value;drawDisc();" style="padding:6px 8px;border:1.5px solid var(--border);border-radius:8px;font-weight:700;font-size:12px;">${DISC_K.map(c=>`<option value="${c.k}"${c.k===col.k?' selected':''}>${c.t}</option>`).join('')}</select>`;
  const pts=months.map(m=>{ const d=D_(m);
    return {label:lbl(m)+(m===now?'*':''), value:d?d[col.k]:null,
      detail:d?`${d.shifts} 班｜缺卡 ${d.miss} 張（未處理 ${d.missOpen}）｜補登 ${d.req} 件｜遲到 ${d.late}/${d.ins} 次｜App 打卡 ${d.app}・補登寫入 ${d.manual}`:''}; });
  box.innerHTML=head
    +`<div style="font-size:12px;color:var(--text-muted);margin:-2px 0 8px;">${monthLabel(cur)}${cur===now?'（進行中）':''}・${D.shifts} 班${D.missOpen?`・<b style="color:#c5221f;">未處理缺卡 ${D.missOpen} 張</b>`:''}</div>`
    +`<div class="kpi-row">${tiles}</div>`
    +`<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;"><span style="font-size:12.5px;font-weight:800;color:var(--text-muted);">趨勢</span>${sel}</div>`
    +lineChart(pts,{color:'#0b5aa8',fmt:v=>v.toFixed(1)+'%',minSpan:10,yoy:'pp'})
    +`<div style="font-size:11px;color:var(--text-muted);margin-top:6px;line-height:1.6;">缺卡率＝缺卡單÷班數（已補登的照算）；補登率＝補登申請÷班數；遲到率＝遲到÷上班卡；App 打卡率＝App 打的卡÷（App 卡＋補登寫入的卡），越高代表越少靠補登。${months.includes(now)?'＊本月進行中，數字還會變。':''}逐筆明細請到「出勤管理」。</div>`;
  pfScrollChartsToEnd(box);
}

function renderAnalysis(){
  const wrap=document.getElementById('tabAnalysis');
  const allM=Object.keys(pnlCache).sort();
  if(!allM.length){wrap.innerHTML=`<div class="empty">尚無損益資料，請先在「損益輸入」建檔（從 2025/7 起）</div>`;return;}
  if(!anaFrom||!allM.includes(anaFrom))anaFrom=allM[0];
  if(!anaTo||!allM.includes(anaTo)||anaTo<anaFrom)anaTo=allM[allM.length-1];
  const months=allM.filter(m=>m>=anaFrom&&m<=anaTo);
  const mOpt=(sel)=>allM.map(m=>`<option value="${m}"${m===sel?' selected':''}>${m.split('-')[0]}/${parseInt(m.split('-')[1])}</option>`).join('');
  const rangeBar=`<div style="display:flex;align-items:center;gap:6px;margin-bottom:12px;font-size:13px;flex-wrap:wrap;">
    <span style="color:var(--text-muted);font-weight:800;">📅 期間</span>
    <select onchange="anaFrom=this.value;renderAnalysis();" style="padding:7px 8px;border:1.5px solid var(--border);border-radius:8px;font-weight:700;">${mOpt(anaFrom)}</select>
    <span>～</span>
    <select onchange="anaTo=this.value;renderAnalysis();" style="padding:7px 8px;border:1.5px solid var(--border);border-radius:8px;font-weight:700;">${mOpt(anaTo)}</select>
  </div>`;
  const lbl=m=>{const p=m.split('-');return `${p[0].slice(2)}/${parseInt(p[1])}`;};
  const pts=months.map(m=>({m,d:pnlCache[m]}));
  const last=months[months.length-1],L=pnlCache[last];
  const yoyD=pnlCache[prevYearMonth(last)]||null;
  const kpi=(label,cur,ym,fmt,unit,goodUp)=>{
    let delta='';
    if(ym!=null){const dv=cur-ym,better=goodUp?dv>=0:dv<=0;delta=`<div class="kpi-delta ${better?'up':'down'}">${better?'▲':'▼'} 同期${goodUp?(dv>=0?'+':''):''}${fmt(Math.abs(dv))}${unit}</div>`;}
    else delta=`<div class="kpi-delta neu">同期無資料</div>`;
    return `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-val">${fmt(cur)}${unit}</div>${delta}</div>`;
  };
  // 人事費率 KPI（人事成本含支援÷營業淨額，越低越好；需該月已結算 perfSnapshot）
  const perfMs=months.filter(m=>perfCache[m]&&!PERF_EXCLUDE.has(m)&&pnlCache[m]&&pnlCache[m].netSales);
  const lp=perfMs.length?perfMs[perfMs.length-1]:null;
  let rateKpi='';
  let surplusKpi='';
  if(lp){const yp=prevYearMonth(lp);const cur=perfCache[lp].laborCost/pnlCache[lp].netSales*100;const ymv=(perfCache[yp]&&pnlCache[yp]&&pnlCache[yp].netSales)?perfCache[yp].laborCost/pnlCache[yp].netSales*100:null;rateKpi=kpi('人事費率',cur,ymv,v=>v.toFixed(1),'%',false);
    const sCur=pnlCache[lp].operatingReward-perfCache[lp].laborCost;const sYm=(perfCache[yp]&&pnlCache[yp])?pnlCache[yp].operatingReward-perfCache[yp].laborCost:null;surplusKpi=kpi('門市餘裕',sCur,sYm,money,'',true);}
  const kpiHtml=`<div class="kpi-row">
    ${kpi('營業淨額',L.netSales,yoyD&&yoyD.netSales,money,'',true)}
    ${kpi('毛利率',L.grossMargin,yoyD&&yoyD.grossMargin,v=>v.toFixed(2),'%',true)}
    ${kpi('經營報酬',L.operatingReward,yoyD&&yoyD.operatingReward,money,'',true)}
    ${rateKpi}
    ${surplusKpi}
  </div><div style="font-size:12px;color:var(--text-muted);margin:-6px 4px 12px;">最新：${last.split('-')[0]}年${parseInt(last.split('-')[1])}月 · ${curStore}（KPI 與去年同期比）</div>`;
  // 每項指標的 Y 軸最小範圍（見 chartRange）與同比口徑（pp＝百分點）
  const SPAN={netSales:{minSpanPct:40},grossMargin:{minSpan:8,yoy:'pp'},operatingReward:{minSpanPct:60},badGoodsCost:{minSpanPct:80},
    elecCost:{minSpanPct:80},miscCost:{minSpanPct:100},cashDiff:{minSpan:6000}};
  const val=(m,key)=>{const d=pnlCache[m]; return (d&&d[key]!=null&&d[key]!=='')?+d[key]:null;};
  const chart=(title,key,fmt,color,unit)=>`<div class="chart-card"><div class="chart-title">${title}</div>${lineChart(pts.map(p=>({label:lbl(p.m),value:val(p.m,key),prev:val(prevYearMonth(p.m),key)})),Object.assign({fmt:v=>fmt(v)+unit,color},SPAN[key]||{}))}</div>`;
  const perfUsable=m=>perfCache[m]&&!PERF_EXCLUDE.has(m)&&pnlCache[m]&&pnlCache[m].netSales;
  const derived=(title,color,fn,fmt,unit,span)=>{const dp=pts.map(p=>{
    const usable=perfUsable(p.m), pm=prevYearMonth(p.m);
    const pf=perfCache[p.m],pn=p.d;
    const det=usable?`營業淨額 ${money(pn.netSales)} 元｜經營報酬 ${money(pn.operatingReward)} 元｜人事成本(含支援) ${money(pf.laborCost)} 元｜總工時 ${pf.totalHours}h（本店${pf.ownHours} 支入${pf.supportInHours||0} 支出${pf.supportOutHours||0}）`:'';
    return {label:lbl(p.m),value:usable?fn(pf,pn):null,prev:perfUsable(pm)?fn(perfCache[pm],pnlCache[pm]):null,detail:det};
  });if(!dp.some(x=>x.value!=null))return '';return `<div class="chart-card"><div class="chart-title">${title}</div>${lineChart(dp,Object.assign({fmt:v=>fmt(v)+unit,color},span||{}))}</div>`;};
  // 淨損耗拆成三段（壞品／盤損攤提／現金短少），盤損負號存（盤損<0）故取負變成正的損失
  const PL=window.PnlLoss;
  const lossRows=pts.map(p=>{const am=amortCache[p.m], pm=prevYearMonth(p.m);
    return {label:lbl(p.m), bad:val(p.m,'badGoodsCost'), inv:(am&&am.amort!=null)?-am.amort:null, cash:val(p.m,'cashDiff'),
      total:PL?PL.netLoss(p.d,am):null, prev:PL?PL.netLoss(pnlCache[pm],amortCache[pm]):null, est:!!(am&&am.est), note:PL?PL.note(am):''};});
  const lossCard=`<div class="chart-card"><div class="chart-title">淨損耗（元，越低越好）</div>${lossBarChart(lossRows)}<div style="font-size:11px;color:var(--text-muted);margin-top:6px;line-height:1.6;">點長條看三項金額。盤點約 60~90 天一次，盤損已平均攤到它涵蓋的每個月；標「估」＝還沒盤點，盤損先沿用上次的月平均（淡色那段）。盤盈、現金溢收不畫進長條，但頂端數字已扣掉。</div></div>`;
  wrap.innerHTML=rangeBar+kpiHtml
    +pfHighlights(last)
    +pfRecentTable(months)
    +chart('營業淨額（元）','netSales',money,'#1a73e8','')
    +chart('經營報酬（元）','operatingReward',money,'#e67e22','')
    +lossCard
    +derived('人事費率（人事成本÷營業淨額 %，越低越好）','#9334e6',(pf,pn)=>pf.laborCost/pn.netSales*100,v=>v.toFixed(1),'%',{minSpan:8,yoy:'pp'})
    +`<div id="discBox" class="chart-card"><div class="chart-title">🕐 出勤紀律</div><div style="font-size:12px;color:var(--text-muted);">載入中…</div></div>`
    +`<details class="chart-card rt-fold more-fold" ontoggle="if(this.open)pfScrollChartsToEnd(this)"><summary class="chart-title">📈 更多指標（毛利率、壞品、電費、雜支、現金短少、人力效率）</summary>`
    +chart('毛利率（%）','grossMargin',v=>v.toFixed(1),'#34a853','')
    +chart('壞品（元）','badGoodsCost',money,'#c5221f','')
    +chart('門市電費（元）','elecCost',money,'#0891b2','')
    +chart('雜支（元）','miscCost',money,'#7c3aed','')
    +chart('現金短少（元，正＝短少為成本）','cashDiff',money,'#c0620f','')
    +`<div style="font-size:12px;color:var(--text-muted);font-weight:700;margin:8px 4px 8px;">人力效率（含支援，需該月薪資已結算，2026/5 起；2026/4 系統剛上線不列入）</div>`
    +derived('每工時營收（營業淨額÷總工時，元/h）','#0891b2',(pf,pn)=>pf.totalHours?pn.netSales/pf.totalHours:null,v=>Math.round(v).toLocaleString('en-US'),'',{minSpanPct:40})
    +derived('門市實際餘裕（經營報酬−人事成本，元）','#137333',(pf,pn)=>pn.operatingReward-pf.laborCost,money,'',{minSpanPct:80})
    +`</details>`
    +(isAdminOwner()?`<div class="chart-card">
      <div class="chart-title" style="margin-bottom:10px;">🏪 三店比較</div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
        <span style="font-size:12.5px;font-weight:800;color:var(--text-muted);">趨勢</span>
        <select id="cmpMetricSel" onchange="cmpMetric=this.value;renderStoreTrend();" style="padding:6px 8px;border:1.5px solid var(--border);border-radius:8px;font-weight:700;font-size:12px;">${Object.keys(METRICS).map(k=>`<option value="${k}"${k===cmpMetric?' selected':''}>${METRICS[k].t}</option>`).join('')}</select>
      </div>
      <div id="storeTrendBox"><div style="font-size:12px;color:var(--text-muted);">載入中…</div></div>
      <div style="height:1px;background:var(--border);margin:14px 0 10px;"></div>
      <div style="font-size:12.5px;font-weight:800;color:var(--text-muted);margin-bottom:6px;">單月對照</div>
      <div id="compareBox"><div style="font-size:12px;color:var(--text-muted);">載入中…</div></div>
    </div>`:'');
  pfScrollChartsToEnd(wrap);
  renderDisc();
  if(isAdminOwner()){ renderStoreTrend(); renderCompare(months[months.length-1]); }
}
let cmpData=null; // {store:{pnl:{m:..},perf:{m:..}}}
let cmpMonth=''; // 三店對照選定的分析年月（獨立於上方範圍）
let cmpMetric='netSales'; // 三店趨勢比較選定指標
const STORE_COLORS={'美德':'#1a73e8','聯鑫':'#e67e22','錦花':'#34a853'};
const METRICS={
  netSales:{t:'營業淨額',fmt:money,get:(pn,pf)=>pn?pn.netSales:null,agg:'sum'},
  grossMargin:{t:'毛利率(%)',fmt:v=>v.toFixed(1),get:(pn,pf)=>pn?pn.grossMargin:null},
  operatingReward:{t:'經營報酬',fmt:money,get:(pn,pf)=>pn?pn.operatingReward:null,agg:'sum'},
  badGoodsCost:{t:'壞品(元)',fmt:money,get:(pn,pf)=>pn?pn.badGoodsCost:null,agg:'sum'},
  elecCost:{t:'門市電費(元)',fmt:money,get:(pn,pf)=>pn?pn.elecCost:null,agg:'sum'},
  miscCost:{t:'雜支(元)',fmt:money,get:(pn,pf)=>pn?pn.miscCost:null,agg:'sum'},
  cashDiff:{t:'現金短少(元)',fmt:money,get:(pn,pf)=>pn?pn.cashDiff:null,agg:'sum'},
  netLoss:{t:'淨損耗(元,含攤提盤損)',fmt:money,get:(pn,pf,am)=>window.PnlLoss?window.PnlLoss.netLoss(pn,am):null,agg:'sum'},
  laborRate:{t:'人事費率(%)',fmt:v=>v.toFixed(1),get:(pn,pf)=>(pn&&pf&&pn.netSales)?pf.laborCost/pn.netSales*100:null},
  revPerHour:{t:'每工時營收',fmt:money,get:(pn,pf)=>(pn&&pf&&pf.totalHours)?pn.netSales/pf.totalHours:null},
  surplus:{t:'門市餘裕(報酬−人事)',fmt:money,get:(pn,pf)=>(pn&&pf)?pn.operatingReward-pf.laborCost:null,agg:'sum'}
};
async function loadAllForCompare(){
  if(cmpData)return;
  cmpData={};
  for(const s of (appConfig.stores||[])){
    cmpData[s]={pnl:{},perf:{}};
    try{const p=await window.db.collection('stores').doc(s).collection('pnl').get();p.forEach(d=>cmpData[s].pnl[d.id]=d.data());}catch(e){}
    cmpData[s].amort=window.PnlLoss?window.PnlLoss.build(cmpData[s].pnl):{};
    try{const q=await window.db.collection('stores').doc(s).collection('perfSnapshot').get();q.forEach(d=>cmpData[s].perf[d.id]=d.data());}catch(e){}
  }
}
async function renderCompare(defaultM){
  const box=document.getElementById('compareBox');if(!box)return;
  await loadAllForCompare();
  const stores=(appConfig.stores||[]).filter(s=>s!=='人力支援');
  // 跨店有資料的年月(union)，供對照選單
  const mset=new Set();
  Object.values(cmpData||{}).forEach(sd=>Object.keys(sd.pnl||{}).forEach(k=>{ if(/^\d{4}-\d{2}$/.test(k)) mset.add(k); }));
  const allMonths=[...mset].sort();
  if(!allMonths.length){ box.innerHTML='<div style="font-size:12px;color:var(--text-muted);padding:8px 4px;">尚無對照資料</div>'; return; }
  let m = (cmpMonth && allMonths.includes(cmpMonth)) ? cmpMonth
        : (defaultM && allMonths.includes(defaultM)) ? defaultM
        : allMonths[allMonths.length-1];
  cmpMonth=m;
  const mOpt=allMonths.map(x=>`<option value="${x}" ${x===m?'selected':''}>${x.split('-')[0]}年${parseInt(x.split('-')[1])}月</option>`).join('');
  const cell=(v)=>v==null?'<td style="text-align:right;color:#bbb;">—</td>':`<td style="text-align:right;">${v}</td>`;
  let rows='';
  const acc={net:[],gm:[],rew:[],bad:[],rate:[],rev:[]};
  stores.forEach(s=>{const pn=cmpData[s]&&cmpData[s].pnl[m];const pf=(cmpData[s]&&!PERF_EXCLUDE.has(m))?cmpData[s].perf[m]:null;
    const rateN=(pf&&pn&&pn.netSales)?pf.laborCost/pn.netSales*100:null;
    const revN=(pf&&pn&&pf.totalHours)?pn.netSales/pf.totalHours:null;
    if(pn){acc.net.push(pn.netSales);acc.gm.push(pn.grossMargin);acc.rew.push(pn.operatingReward);if(pn.badGoodsCost!=null)acc.bad.push(pn.badGoodsCost);}
    if(rateN!=null)acc.rate.push(rateN); if(revN!=null)acc.rev.push(revN);
    rows+=`<tr><td style="font-weight:800;">${s}</td>${cell(pn?money(pn.netSales):null)}${cell(pn?pn.grossMargin+'%':null)}${cell(pn?money(pn.operatingReward):null)}${cell(pn&&pn.badGoodsCost!=null?money(pn.badGoodsCost):null)}${cell(rateN!=null?rateN.toFixed(1)+'%':null)}${cell(revN!=null?Math.round(revN).toLocaleString('en-US'):null)}</tr>`;
  });
  const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
  const sum=a=>a.length?a.reduce((x,y)=>x+y,0):null;
  const acell=(v)=>v==null?'<td style="text-align:right;color:#bbb;">—</td>':`<td style="text-align:right;font-weight:800;">${v}</td>`;
  // 金額用總計、比率用平均，分兩列
  rows+=`<tr style="border-top:1.5px solid var(--border);background:#f8fafc;"><td style="font-weight:800;color:var(--primary);">總計</td>`+
    `${acell(sum(acc.net)!=null?money(sum(acc.net)):null)}${acell(null)}`+
    `${acell(sum(acc.rew)!=null?money(sum(acc.rew)):null)}${acell(sum(acc.bad)!=null?money(sum(acc.bad)):null)}${acell(null)}${acell(null)}</tr>`;
  rows+=`<tr style="background:#f8fafc;"><td style="font-weight:800;color:var(--primary);">平均</td>`+
    `${acell(null)}${acell(avg(acc.gm)!=null?avg(acc.gm).toFixed(1)+'%':null)}`+
    `${acell(null)}${acell(null)}${acell(avg(acc.rate)!=null?avg(acc.rate).toFixed(1)+'%':null)}`+
    `${acell(avg(acc.rev)!=null?Math.round(avg(acc.rev)).toLocaleString('en-US'):null)}</tr>`;
  box.innerHTML=`
    <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-bottom:8px;">
      <select onchange="cmpMonth=this.value;renderCompare();" style="padding:6px 8px;border:1.5px solid var(--border);border-radius:8px;font-weight:700;font-size:12px;">${mOpt}</select>
    </div>
    <div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12.5px;white-space:nowrap;">
    <thead><tr style="color:var(--text-muted);font-size:11px;"><th style="text-align:left;padding:4px;">門市</th><th style="text-align:right;padding:4px;">營業淨額</th><th style="text-align:right;">毛利率</th><th style="text-align:right;">經營報酬</th><th style="text-align:right;">壞品</th><th style="text-align:right;">人事費率</th><th style="text-align:right;">每工時營收</th></tr></thead>
    <tbody>${rows}</tbody></table></div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:6px;">人事費率＝人事成本(含支援)÷營業淨額；人事類 2026/5 起才有，2026/4 不列入；—代表該月尚無資料</div>`;
}
