let currentUser=null, appConfig={}, DATA={}, STORES=[], curHealthStore='';
const STORE_COLORS={'美德':'#1a73e8','聯鑫':'#e67e22','錦花':'#34a853'};
const PERF_EXCLUDE=new Set(['2026-04']); // 系統剛上線該月人事成本不完整
const isOwner=()=>['owner','admin'].includes(currentUser?.permission);
const money=n=>Math.round(n||0).toLocaleString('en-US');
const n=v=>{const x=parseFloat(v);return isFinite(x)?x:0;};
// 輕量 Markdown → HTML（先跳脫 HTML 再套用，安全）：# ## ### 標題、- 項目、--- 分隔線、**粗體**、| 表格 |、> 引用
// 2026-10-10 補表格與引用：營運檢討裡的表格原本顯示成一行行的「| 門市 | 2025/9 |」。
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function mdToHtml(md){
  const inl=t=>t.replace(/\*\*(.+?)\*\*/g,'<b>$1</b>');
  let html='',inList=false,tbl=null; const closeList=()=>{if(inList){html+='</ul>';inList=false;}};
  const cells=l=>l.replace(/^\|/,'').replace(/\|$/,'').split('|').map(c=>inl(c.trim()));
  const closeTbl=()=>{ if(!tbl) return;
    const [h,...rows]=tbl;   // 第一列當表頭；|---| 分隔列已略過
    html+=`<div class="scroll"><table><thead><tr>${h.map(c=>`<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    tbl=null; };
  esc(md).split(/\r?\n/).forEach(raw=>{
    const line=raw.replace(/\s+$/,'');
    if(/^\|.*\|$/.test(line)){ closeList(); if(/^\|[\s:|-]+\|$/.test(line)) return; (tbl=tbl||[]).push(cells(line)); return; }
    closeTbl();
    if(/^&gt;\s?/.test(line)){closeList();html+=`<blockquote>${inl(line.replace(/^&gt;\s?/,''))}</blockquote>`;}
    else if(/^###\s+/.test(line)){closeList();html+=`<h4>${inl(line.replace(/^###\s+/,''))}</h4>`;}
    else if(/^##\s+/.test(line)){closeList();html+=`<h3>${inl(line.replace(/^##\s+/,''))}</h3>`;}
    else if(/^#\s+/.test(line)){closeList();html+=`<h2>${inl(line.replace(/^#\s+/,''))}</h2>`;}
    else if(/^[-*]\s+/.test(line)){if(!inList){html+='<ul>';inList=true;}html+=`<li>${inl(line.replace(/^[-*]\s+/,''))}</li>`;}
    else if(/^---+$/.test(line)){closeList();html+='<hr>';}
    else if(line===''){closeList();}
    else{closeList();html+=`<p>${inl(line)}</p>`;}
  });
  closeList(); closeTbl(); return html;
}
function showLoading(){document.getElementById('loadingOverlay').classList.remove('hidden');}
function hideLoading(){document.getElementById('loadingOverlay').classList.add('hidden');}
// 週次字串必須是排班表 getWeekDates() 的精準反函式（每週以「週一」起算）。
// 舊寫法直接把日期套年度週次，週界會隨該年 1/1 是星期幾而變 →「月初落在週六/週日」的月份會整週漏抓。
function week1MondayOf(yr){const d=new Date(yr,0,1),day=d.getDay();d.setDate(d.getDate()+(day<=4?1-day:8-day));return d;}
function simpleWeekStr(dt){
  const mon=new Date(dt.getFullYear(),dt.getMonth(),dt.getDate());   // 去掉時間
  mon.setDate(mon.getDate()-((mon.getDay()+6)%7));                   // 退到該日所屬的週一
  let yr=mon.getFullYear();
  if(mon<week1MondayOf(yr))yr--;else if(mon>=week1MondayOf(yr+1))yr++;
  const w=Math.round((mon-week1MondayOf(yr))/604800000)+1;
  return `${yr}-W${w<10?'0'+w:w}`;
}
function ymMinus12(ym){const[y,m]=ym.split('-');return `${+y-1}-${m}`;}
function weeksForMonth(ym){const[y,mo]=ym.split('-').map(Number);const set=new Set();const days=new Date(y,mo,0).getDate();for(let d=1;d<=days;d++)set.add(simpleWeekStr(new Date(y,mo-1,d)));return[...set];}

window.onload=async()=>{
  showLoading();
  const saved=localStorage.getItem('currentUser')||sessionStorage.getItem('currentUser');
  if(!saved){location.replace('home.html');return;}
  try{currentUser=JSON.parse(saved);}catch(e){location.replace('home.html');return;}
  const fb=await new Promise(r=>{const u=firebase.auth().onAuthStateChanged(x=>{u();r(x);});});
  if(!fb){localStorage.removeItem('currentUser');location.replace('home.html');return;}
  if(!isOwner()){ document.getElementById('content').innerHTML='<div class="empty">此頁僅加盟主／管理者可用</div>'; hideLoading(); setTimeout(()=>location.replace('home.html'),1200); return; }
  try{const s=await window.db.collection('settings').doc('globalConfig').get();if(s.exists)appConfig=s.data();}catch(e){}
  STORES=(appConfig.stores||[]).filter(s=>s!=='人力支援');
  await loadAll();
  hideLoading();
  const months=allMonths();
  if(!months.length){ document.getElementById('content').innerHTML='<div class="empty">尚無經營資料</div>'; return; }
  const sel=document.getElementById('monthSel');
  sel.innerHTML=months.map(m=>`<option value="${m}">${m.split('-')[0]}年${+m.split('-')[1]}月</option>`).join('');
  sel.value=months[months.length-1];
  OwnerScope.render(document.getElementById('scopeBar'), STORES);
  renderMainTabs();
  OwnerScope.onChange(()=>{ OwnerScope.render(document.getElementById('scopeBar'), STORES); renderAll(dashMonth); window.scrollTo(0,0); });
  renderAll(sel.value);
  // 未休假獎金估算：每人要讀特休批次與補休帳本，放背景載入，好了再重畫（不擋第一屏）
  loadLeaveEstimate().then(()=>{ if(dashView==='main') renderAll(dashMonth); }).catch(e=>console.warn('未休假獎金估算失敗',e));
};

async function loadAll(){
  DATA={};
  for(const s of STORES){
    DATA[s]={pnl:{},perf:{},monthly:{}};
    try{const p=await window.db.collection('stores').doc(s).collection('pnl').get();p.forEach(d=>DATA[s].pnl[d.id]=d.data());}catch(e){}
    try{const q=await window.db.collection('stores').doc(s).collection('perfSnapshot').get();q.forEach(d=>DATA[s].perf[d.id]=d.data());}catch(e){}
    try{const mo=await window.db.collection('stores').doc(s).collection('monthly').get();mo.forEach(d=>DATA[s].monthly[d.id]=d.data());}catch(e){}
    DATA[s].amort=window.PnlLoss?window.PnlLoss.build(DATA[s].pnl):{};
  }
}
function allMonths(){const set=new Set();STORES.forEach(s=>Object.keys(DATA[s].pnl||{}).forEach(k=>{if(/^\d{4}-\d{2}$/.test(k))set.add(k);}));return[...set].sort();}
function pnlOf(s,m){return DATA[s]&&DATA[s].pnl[m];}
function perfOf(s,m){return (DATA[s]&&!PERF_EXCLUDE.has(m))?DATA[s].perf[m]:null;}
// 盤損攤提：盤點 60~90 天一次，盤損屬整個區間 → 攤到每個月，口徑見 pnl-loss.js
function amortOf(s,m){return (DATA[s]&&DATA[s].amort)?DATA[s].amort[m]:null;}

// ===== 主渲染 =====
// 檢視切換：'main'＝儀表板全貌（計分卡只留摘要）、'score'＝只看計分卡
// 同一頁換內容，不是另開網頁；月域掃描結果快取起來，切來切去不會重打 Firestore。
var dashView='main', dashMonth='', dashCache={};
// 〔總覽〕〔人事〕（2026-10-10 人事分析併入；人事分頁在 owner-hr.js，點了才讀資料）
var mainTab=(function(){ try{ const v=new URLSearchParams(location.search).get('view'); if(v==='hr'||v==='overview') return v; return localStorage.getItem('odMainTab')||'overview'; }catch(e){ return 'overview'; } })();
function renderMainTabs(){
  const el=document.getElementById('mainTabs'); if(!el) return;
  el.innerHTML=[['overview','總覽'],['hr','人事']].map(([k,t])=>`<button role="tab" aria-selected="${mainTab===k}" class="${mainTab===k?'on':''}" onclick="setMainTab('${k}')">${t}</button>`).join('');
  const ms=document.getElementById('monthSel'); if(ms) ms.style.visibility = mainTab==='hr' ? 'hidden' : '';   // 人事分頁有自己的區間
}
function setMainTab(k){ mainTab=k; try{ localStorage.setItem('odMainTab',k); }catch(e){} renderMainTabs(); renderAll(dashMonth); window.scrollTo(0,0); }
function openScoreView(){ dashView='score'; renderAll(dashMonth); window.scrollTo(0,0); }
function closeScoreView(){ dashView='main'; renderAll(dashMonth); window.scrollTo(0,0); }

async function renderAll(m){
  dashMonth=m;
  const el=document.getElementById('content');
  if(mainTab==='hr'){ destroyCharts(); el.innerHTML='<div id="hrRoot"></div>'; if(window.HR) HR.render(); return; }
  el.innerHTML='<div class="empty">計算中…</div>';
  let c=dashCache[m];
  if(!c){
    // 月域掃描（合規/出勤/流動）
    const extra={};
    await Promise.all(STORES.map(async s=>{ extra[s]=await scanMonth(s,m); }));
    let review=null;
    try{ const rd=await window.db.collection('monthlyReviews').doc(m).get(); if(rd.exists) review=rd.data(); }catch(e){}
    c=dashCache[m]={extra,review};
  }
  if(dashView==='score'){
    el.innerHTML = `<button class="back-btn" onclick="closeScoreView()">← 回儀表板</button>` + renderScorecard(m,c.extra,'full');
    return;
  }
  // 方案 D（2026-10-10）：最上面先看「這個月要處理」，其餘收成一行摘要的摺疊區塊；
  // 頂端切換三店／單店，單店時同樣版面只顯示那一家。
  const scope=OwnerScope.get(), only=scope?[scope]:STORES;
  if(scope) curHealthStore=scope;
  const al=collectAlerts(m,c.extra);
  const hs=healthSummary(curHealthStore||STORES[0]);
  const dsc=only.filter(s=>c.extra[s]&&c.extra[s].disc);
  const worstMiss=dsc.slice().sort((a,b)=>(c.extra[b].disc.missRate||0)-(c.extra[a].disc.missRate||0))[0];
  const discSum=!dsc.length?'無資料':scope?`缺卡 ${fmtPct(c.extra[scope].disc.missRate)}・未處理 ${c.extra[scope].disc.missOpen} 張`:`${worstMiss} 缺卡率最高 ${fmtPct(c.extra[worstMiss].disc.missRate)}`;
  const reviewSum=(c.review&&c.review.text)?'已填寫':'尚未填寫';
  // 圖表版（2026-10-10）：數字卡帶趨勢線＋三張圖；三店比較表拿掉（改長條圖）、成本體檢不再有輸入框與明細表
  let html=renderTodo(m,al,scope)+renderOverview(m,only);
  html+= scope ? renderStoreCharts(m,scope,c.extra) : renderGroupCharts(m);
  html+=renderLeaveEstimate(scope);
  html+=fold('score','👔','店長計分卡',scoreSummary(m,c.extra,scope),scope?renderScorecard(m,c.extra,'store',scope):renderScorecard(m,c.extra,'body'));
  html+=fold('health','🩺','成本體檢',hs,renderHealthSection(!!scope));
  html+=fold('disc','🕐','出勤紀律',discSum,renderDiscipline(m,c.extra,only,true));
  html+=fold('review','📋','營運檢討',reviewSum,renderReview(m,c.review,true));
  html+=renderLinks();
  destroyCharts();
  el.innerHTML=html;
  drawPendingCharts();
  renderStoreHealth();
}
const fmtPct=v=>v==null?'—':v+'%';
// ===== 圖表版工具（2026-10-10）=====
const wan=v=>v==null?'—':(Math.abs(v)>=10000?(Math.round(v/1000)/10)+' 萬':money(v));
function prevYm(ym){ const [y,mo]=ym.split('-').map(Number); const d=new Date(y,mo-2,1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function monthsUpTo(m,k){ const out=[]; let x=m; for(let i=0;i<k;i++){ out.unshift(x); x=prevYm(x); } return out; }
// 合計 only 門市在 ym 的值；fn(pn,pf) 回傳 falsy(非 0)＝該店沒資料；全部沒資料回 null（不可回 0，0 是合法值）
function sumOf(only,ym,fn){ let t=0, ok=false; only.forEach(s=>{ const v=fn(pnlOf(s,ym),perfOf(s,ym)); if(v!==null&&v!==undefined&&v!==false){ t+=v; ok=true; } }); return ok?t:null; }
// 小趨勢線：沒資料的月份斷開；最後一點加圓點
function sparkSvg(vals,color,zeroLine){
  const pts=vals.map((v,i)=>({i,v})).filter(p=>p.v!=null&&isFinite(p.v));
  if(pts.length<2) return '';
  let lo=Math.min(...pts.map(p=>p.v)), hi=Math.max(...pts.map(p=>p.v)); if(zeroLine){ lo=Math.min(lo,0); hi=Math.max(hi,0); }
  if(hi===lo){ hi+=1; lo-=1; }
  const X=i=>vals.length<=1?50:i/(vals.length-1)*100, Y=v=>26-(v-lo)/(hi-lo)*22;
  let d='', prev=-2; pts.forEach(p=>{ d+=(p.i===prev+1?'L':'M')+X(p.i).toFixed(1)+' '+Y(p.v).toFixed(1)+' '; prev=p.i; });
  const last=pts[pts.length-1];
  const z=zeroLine&&lo<0?`<line x1="0" x2="100" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="2 2" vector-effect="non-scaling-stroke"/>`:'';
  return `<svg class="kpi-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">${z}<path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/><circle cx="${X(last.i).toFixed(1)}" cy="${Y(last.v).toFixed(1)}" r="2.2" fill="${color}"/></svg>`;
}
// Chart.js：先排隊，innerHTML 設好之後再畫
let _charts=[], _pendingCharts=[];
function destroyCharts(){ _charts.forEach(c=>{ try{ c.destroy(); }catch(e){} }); _charts=[]; }
function queueChart(id,cfg){ _pendingCharts.push({id,cfg}); return `<div class="chart-box"><canvas id="${id}"></canvas></div>`; }
function drawPendingCharts(){
  const list=_pendingCharts; _pendingCharts=[];
  if(!window.Chart) return;
  list.forEach(({id,cfg})=>{ const el=document.getElementById(id); if(el) _charts.push(new Chart(el,cfg)); });
}
const chartOpts=(yFmt,extra)=>Object.assign({ responsive:true, maintainAspectRatio:false, interaction:{mode:'index',intersect:false},
  plugins:{ legend:{position:'bottom',labels:{boxWidth:10,boxHeight:10,font:{size:11}}}, tooltip:{callbacks:{label:c=>`${c.dataset.label}：${c.parsed.y==null?'—':yFmt(c.parsed.y)}`}} },
  scales:{ y:{ticks:{callback:v=>yFmt(v),font:{size:10}},grid:{color:'#f1f5f9'}}, x:{ticks:{font:{size:10}},grid:{display:false}} } }, extra||{});
const mLabel=ym=>`${+ym.slice(5)}月`;
// 三店：營收走勢、本月餘裕長條、人事費率趨勢
function renderGroupCharts(m){
  const ms=monthsUpTo(m,12).filter(x=>STORES.some(s=>pnlOf(s,x)));
  const net=queueChart('chNet',{ type:'line', data:{ labels:ms.map(mLabel), datasets:STORES.map(s=>({ label:s, data:ms.map(x=>{ const pn=pnlOf(s,x); return pn?Math.round(n(pn.netSales)/1000)/10:null; }), borderColor:STORE_COLORS[s]||'#888', backgroundColor:STORE_COLORS[s]||'#888', borderWidth:2, pointRadius:2, tension:.3, spanGaps:false })) }, options:chartOpts(v=>v+' 萬') });
  const sur=STORES.map(s=>{ const pn=pnlOf(s,m), pf=perfOf(s,m); return {s, v:(pn&&pf)?n(pn.operatingReward)-n(pf.laborCost):null}; });
  const mx=Math.max(1,...sur.filter(x=>x.v!=null).map(x=>Math.abs(x.v)));
  const bars=sur.sort((a,b)=>(b.v??-1e12)-(a.v??-1e12)).map(x=>`<div class="hbar" style="cursor:pointer;" onclick="OwnerScope.set('${x.s}')"><span class="nm">${x.s}</span><span class="trk">${x.v==null?'':`<i class="fil" style="left:0;width:${Math.max(3,Math.abs(x.v)/mx*100)}%;background:${x.v>=0?'#34a853':'#d93025'};"></i>`}</span><span class="v" style="color:${x.v==null?'#94a3b8':x.v>=0?'#137333':'#c5221f'}">${x.v==null?'無資料':(x.v>0?'+':'')+wan(x.v)}</span></div>`).join('');
  const rms=monthsUpTo(m,12).filter(x=>STORES.some(s=>pnlOf(s,x)&&perfOf(s,x)));
  const rate=rms.length?queueChart('chRate',{ type:'line', data:{ labels:rms.map(mLabel), datasets:STORES.map(s=>({ label:s, data:rms.map(x=>{ const pn=pnlOf(s,x), pf=perfOf(s,x); return (pn&&pf&&n(pn.netSales))?Math.round(n(pf.laborCost)/n(pn.netSales)*1000)/10:null; }), borderColor:STORE_COLORS[s]||'#888', backgroundColor:STORE_COLORS[s]||'#888', borderWidth:2, pointRadius:2, tension:.3 })) }, options:chartOpts(v=>v+'%') }):'<div class="empty">尚無人事資料</div>';
  return `<div class="chart-card"><div class="chart-t">📈 營業淨額走勢</div><div class="chart-s">近 12 個月・單位萬元</div>${net}</div>
  <div class="chart-card"><div class="chart-t">💰 ${mLabel(m)}門市餘裕</div><div class="chart-s">經營報酬－人事成本（含支援）・綠＝賺、紅＝虧・點門市看那一家</div>${bars}</div>
  <div class="chart-card"><div class="chart-t">📐 人事費率</div><div class="chart-s">人事成本÷營業淨額・人事資料 2026/4 起</div>${rate}</div>`;
}
// 單店：今年 vs 去年同月、每工時人事成本＋合理範圍、出勤長條
function renderStoreCharts(m,s,extra){
  const ms=monthsUpTo(m,6).filter(x=>pnlOf(s,x));
  const yoy=queueChart('chYoy',{ type:'bar', data:{ labels:ms.map(mLabel), datasets:[
    { label:'去年同月', data:ms.map(x=>{ const p=pnlOf(s,ymMinus12(x)); return p?Math.round(n(p.netSales)/1000)/10:null; }), backgroundColor:'#cbd5e1', borderRadius:4 },
    { label:'今年', data:ms.map(x=>{ const p=pnlOf(s,x); return p?Math.round(n(p.netSales)/1000)/10:null; }), backgroundColor:STORE_COLORS[s]||'#1a73e8', borderRadius:4 } ] }, options:chartOpts(v=>v+' 萬') });
  const se=healthSeries(s).slice(-6);
  let cph='<div class="empty">尚無人事成本資料</div>';
  if(se.length){
    const hist=se.slice(0,-1).map(x=>x.cph).filter(v=>v>0), avg=hist.length?hist.reduce((a,b)=>a+b,0)/hist.length:se[se.length-1].cph;
    const lo=Math.round(avg*0.9), hi=Math.round(avg*1.1);
    cph=queueChart('chCph',{ type:'line', data:{ labels:se.map(x=>mLabel(x.ym)), datasets:[
      { label:'合理上限', data:se.map(()=>hi), borderColor:'rgba(52,168,83,.25)', backgroundColor:'rgba(52,168,83,.10)', pointRadius:0, borderWidth:1, fill:'+1' },
      { label:'合理下限', data:se.map(()=>lo), borderColor:'rgba(52,168,83,.25)', pointRadius:0, borderWidth:1, fill:false },
      { label:'每工時成本', data:se.map(x=>x.cph), borderColor:'#1a73e8', backgroundColor:'#1a73e8', borderWidth:2.5, pointRadius:3, tension:.3 } ] },
      options:chartOpts(v=>'$'+v,{ plugins:{ legend:{display:false}, tooltip:{callbacks:{label:c=>`${c.dataset.label}：$${c.parsed.y}`}} } }) });
    cph+=`<div style="font-size:11px;color:var(--muted);margin-top:4px;">淺綠帶＝過去幾個月平均 ±10%（$${money(lo)}–$${money(hi)}）</div>`;
  }
  const d=(extra[s]||{}).disc;
  const bar=(lbl,v,col,bg)=>`<div class="hbar"><span class="nm" style="min-width:52px;">${lbl}</span><span class="trk" style="background:${bg};">${v==null?'':`<i class="fil" style="left:0;width:${Math.min(100,Math.max(2,v))}%;background:${col};"></i>`}</span><span class="v">${v==null?'—':v+'%'}</span></div>`;
  const disc=d?bar('缺卡率',d.missRate,'#d93025','#fce8e6')+bar('補登率',d.reqRate,'#e67e22','#fff3e0')+bar('遲到率',d.lateRate,'#e67e22','#fff3e0')+`<div style="font-size:11px;color:var(--muted);margin-top:4px;">未處理缺卡 ${d.missOpen} 張・班數 ${d.shifts}</div>`:'<div class="empty">本月尚無打卡資料</div>';
  return `<div class="chart-card"><div class="chart-t">📈 營業淨額：今年 vs 去年同月</div><div class="chart-s">近 6 個月・單位萬元</div>${yoy}</div>
  <div class="chart-card"><div class="chart-t">⏱️ 每工時人事成本</div><div class="chart-s">含公司負擔・近 6 個月</div>${cph}</div>
  <div class="chart-card"><div class="chart-t">🕐 ${mLabel(m)}出勤</div><div class="chart-s">缺卡率＝缺卡單÷班數（已補登的照算）</div>${disc}</div>`;
}
// 摺疊區塊：記住每個區塊開或關（每台裝置）
function foldOpen(id){ try{ return localStorage.getItem('odFold:'+id)==='1'; }catch(e){ return false; } }
function foldToggle(id,el){ try{ localStorage.setItem('odFold:'+id, el.open?'1':'0'); }catch(e){} }
function fold(id,ic,title,summary,body){
  return `<details class="fold" ${foldOpen(id)?'open':''} ontoggle="foldToggle('${id}',this)"><summary><span class="fold-t">${ic} ${title}</span><span class="fold-s">${summary||''}</span></summary><div class="fold-b">${body}</div></details>`;
}

// ===== 單店成本體檢（每工時人事成本／加班佔比／合理帶／決策提示；讀 monthly 聚合，缺則 perfSnapshot）=====
function renderHealthSection(fixed){
  if(!curHealthStore) curHealthStore=STORES[0]||'';
  const inp='padding:5px 7px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;font-weight:700;';
  return `<div class="card">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
      ${fixed?'':`<select id="healthStore" onchange="curHealthStore=this.value;renderStoreHealth();" style="${inp}">${STORES.map(s=>`<option value="${s}"${s===curHealthStore?' selected':''}>${s}</option>`).join('')}</select>`}
    </div>
    <div id="storeHealth"></div>
  </div>`;
}
function renderStoreHealth(){
  const el=document.getElementById('storeHealth'); if(!el)return;
  const s=curHealthStore;
  const otTarget=parseFloat((document.getElementById('otTarget')||{}).value)||8;
  const bandPct=(parseFloat((document.getElementById('bandPct')||{}).value)||10)/100;
  const series=healthSeries(s);
  if(!series.length){ el.innerHTML='<div class="empty">此店尚無成本資料（發布薪資後產生聚合）</div>'; return; }
  const last=series[series.length-1], prev=series[series.length-2];
  const hist=series.slice(0,-1).map(x=>x.cph).filter(v=>v>0);
  const avg=hist.length?Math.round(hist.reduce((a,b)=>a+b,0)/hist.length):last.cph;
  const lo=Math.round(avg*(1-bandPct)), hi=Math.round(avg*(1+bandPct));
  const cphSt=last.cph>hi?{c:'#c5221f',t:'偏高'}:last.cph<lo?{c:'#137333',t:'偏低(佳)'}:{c:'#137333',t:'合理'};
  return renderStoreHealthBody(el,series,last,prev,avg,lo,hi,cphSt,otTarget);
}
// 單店成本序列（monthly 聚合優先，缺則 perfSnapshot）
function healthSeries(s){
  const M=DATA[s]||{};
  const mset=new Set([...Object.keys(M.monthly||{}),...Object.keys(M.perf||{})].filter(k=>/^\d{4}-\d{2}$/.test(k)&&!PERF_EXCLUDE.has(k)));
  return [...mset].sort().map(ym=>{
    const mo=M.monthly&&M.monthly[ym];
    if(mo) return {ym,cph:n(mo.costPerHour)||(n(mo.totalHours)?Math.round(n(mo.totalCost)/n(mo.totalHours)):0),otRatio:mo.otRatio!=null?n(mo.otRatio):null,cost:n(mo.totalCost),hours:n(mo.totalHours),ot:mo.otHours!=null?n(mo.otHours):null,head:mo.headcount||null};
    const pf=M.perf&&M.perf[ym];
    if(pf&&n(pf.totalHours)) return {ym,cph:Math.round(n(pf.laborCost)/n(pf.totalHours)),otRatio:null,cost:n(pf.laborCost),hours:n(pf.totalHours),ot:null,head:null};
    return null;
  }).filter(x=>x&&(x.cph>0||x.cost>0));
}
function healthSummary(s){
  const se=healthSeries(s); if(!se.length) return '尚無資料';
  const last=se[se.length-1], hist=se.slice(0,-1).map(x=>x.cph).filter(v=>v>0);
  const avg=hist.length?hist.reduce((a,b)=>a+b,0)/hist.length:last.cph;
  const t=last.cph>avg*1.1?'偏高':last.cph<avg*0.9?'偏低':'合理';
  return `${s} 每工時 $${money(last.cph)}・${t}`;
}
function renderStoreHealthBody(el,series,last,prev,avg,lo,hi,cphSt,otTarget){
  const otSt=last.otRatio==null?{c:'#64748b',t:'—'}:last.otRatio>otTarget?{c:'#c5221f',t:'超標'}:{c:'#137333',t:'達標'};
  const mom=(cur,pv)=>pv?`<span style="font-size:11px;font-weight:800;color:${cur>pv?'#c5221f':'#137333'};">${cur>pv?'▲':'▼'}${Math.abs(Math.round((cur-pv)/pv*1000)/10)}%</span>`:'';
  const kpi=`<div class="kpi-grid" style="margin-bottom:4px;">
    <div class="kpi"><div class="kpi-label">⏱️ 每工時人事成本</div><div class="kpi-val" style="color:${cphSt.c};">$${money(last.cph)}</div><div class="kpi-yoy flat">含公司負擔 ${prev?mom(last.cph,prev.cph):''}</div><div class="kpi-yoy" style="color:${cphSt.c};">${cphSt.t}（帶 $${money(lo)}–$${money(hi)}）</div></div>
    <div class="kpi"><div class="kpi-label">⚡ 加班佔比</div><div class="kpi-val" style="color:${otSt.c};">${last.otRatio==null?'—':last.otRatio+'%'}</div><div class="kpi-yoy flat">${last.ot!=null?`加班${last.ot}h / 總${last.hours}h`:'需薪資聚合'} ${(prev&&last.otRatio!=null&&prev.otRatio!=null)?mom(last.otRatio,prev.otRatio):''}</div><div class="kpi-yoy" style="color:${otSt.c};">${otSt.t}（目標 ≤${otTarget}%）</div></div>
    <div class="kpi"><div class="kpi-label">💰 月總成本</div><div class="kpi-val">$${money(last.cost)}</div><div class="kpi-yoy flat">${last.ym} ${prev?mom(last.cost,prev.cost):''}</div></div>
    <div class="kpi"><div class="kpi-label">👥 人數(正/工/店長)</div><div class="kpi-val" style="font-size:19px;">${last.head?`${last.head.full||0}/${last.head.part||0}/${last.head.manager||0}`:'—'}</div><div class="kpi-yoy flat">總工時 ${last.hours}h</div></div>
  </div>`;
  const tips=[];
  if(last.otRatio!=null&&last.otRatio>otTarget){ const tH=Math.round(last.hours*otTarget/100*10)/10; const save=Math.round((last.ot-tH)*10)/10; tips.push(`⚡ 加班佔比 ${last.otRatio}% 超過目標 ${otTarget}%：降到目標約可少 <b>${save}h</b> 加班（檢視排班密度／增補人力）。`); }
  if(last.cph>hi) tips.push(`⏱️ 每工時成本 $${money(last.cph)} 高於近期均 $${money(avg)}（+${Math.round((last.cph-avg)/avg*1000)/10}%），留意人力配置／薪資結構。`);
  if(!tips.length) tips.push('✅ 本月每工時成本與加班佔比皆在合理範圍。');
  const tipsHtml=`<div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:10px;padding:11px 13px;margin:10px 0;font-size:12.5px;line-height:1.8;">${tips.map(t=>`<div>${t}</div>`).join('')}</div>`;
  // 2026-10-10 圖表版：月度明細表改成趨勢圖；單店模式第一頁已有同一張圖，這裡就不重複
  const showTrend=!OwnerScope.get();
  el.innerHTML=kpi+tipsHtml+(showTrend?`<div style="font-size:12px;font-weight:800;color:var(--muted);margin:6px 0 4px;">📈 每工時人事成本（淺綠帶＝合理範圍 $${money(lo)}–$${money(hi)}）</div><div class="chart-box" style="height:160px;"><canvas id="chHealth"></canvas></div>`:'');
  if(_healthChart){ try{ _healthChart.destroy(); }catch(e){} _healthChart=null; }
  const cv=document.getElementById('chHealth');
  if(cv&&window.Chart){
    const se=series.slice(-6);
    _healthChart=new Chart(cv,{ type:'line', data:{ labels:se.map(x=>mLabel(x.ym)), datasets:[
      { label:'合理上限', data:se.map(()=>hi), borderColor:'rgba(52,168,83,.25)', backgroundColor:'rgba(52,168,83,.10)', pointRadius:0, borderWidth:1, fill:'+1' },
      { label:'合理下限', data:se.map(()=>lo), borderColor:'rgba(52,168,83,.25)', pointRadius:0, borderWidth:1, fill:false },
      { label:'每工時成本', data:se.map(x=>x.cph), borderColor:STORE_COLORS[curHealthStore]||'#1a73e8', backgroundColor:STORE_COLORS[curHealthStore]||'#1a73e8', borderWidth:2.5, pointRadius:3, tension:.3 } ] },
      options:chartOpts(v=>'$'+v,{ plugins:{ legend:{display:false}, tooltip:{callbacks:{label:c=>`${c.dataset.label}：$${c.parsed.y}`}} } }) });
  }
}
let _healthChart=null;

async function scanMonth(store,ym){
  const out={law:0, late:0, turnover:null, head:null, left:null, mgr:''};
  // 合規：該月週次記錄有 lawOverrides(知情放行)
  try{ for(const wk of weeksForMonth(ym)){ const wd=await window.db.collection('stores').doc(store).collection('weeks').doc(wk).get(); if(wd.exists)(wd.data().records||[]).forEach(r=>{if(r.lawOverrides&&r.lawOverrides.length)out.law++;}); } }catch(e){ out.law=null; }
  // 出勤紀律：該月遲到/早退/缺卡筆數
  let att=null;
  try{ const a=await window.db.collection('stores').doc(store).collection('attendance').where('date','>=',ym+'-01').where('date','<=',ym+'-31').get(); att=a.docs.map(d=>d.data()); let c=0; att.forEach(x=>{const st=x.status;if(st==='遲到'||st==='早退'||st==='缺卡')c++;}); out.late=att.length?c:null; }catch(e){ out.late=null; }
  // 出勤紀律追蹤：同一批打卡資料再加上當月補登申請
  out.disc = att ? disciplineOf(att, await monthRequests(store,ym)) : null;
  // 員工流動率：該月離職/調走人數 ÷ 在職
  try{ const es=await window.db.collection('stores').doc(store).collection('employees').get(); let head=0,left=0; es.forEach(d=>{const e=d.data();const st=e.status||'';const retired=st==='離職'||st==='調走';if(!retired)head++;if(!retired&&e.role==='店長'&&!out.mgr)out.mgr=e.displayName||d.id;const eff=e.retireDate||e.transferDate||'';if(retired&&eff&&eff.slice(0,7)===ym)left++;}); out.head=head;out.left=left;out.turnover=(head+left)>0?Math.round(left/(head+left)*1000)/10:0; }catch(e){}
  return out;
}

// ===== 出勤紀律追蹤（2026-10-10）：缺卡率／補登率／遲到率／未處理缺卡 =====
// 分母「班數」＝當月有配到班別的上下班卡＋缺卡單，以「人｜班別日｜班別」去重（排班表不用另外讀）。
// 缺卡單：因「已補登／代為補登」被註銷的照算（缺卡確實發生過）；因排班變更等原因被註銷的不算（那張單本來就不成立）。
async function monthRequests(store,ym){
  try{ const q=await window.db.collection('stores').doc(store).collection('attendanceRequests').where('targetDate','>=',ym+'-01').where('targetDate','<=',ym+'-31').get(); return q.docs.map(d=>d.data()); }
  catch(e){ return []; }
}
function disciplineOf(att, reqs){
  const keys=new Set(); let miss=0, missOpen=0, late=0, ins=0;
  att.forEach(a=>{
    const day=a.shiftDate||a.date;
    if(a.type==='缺卡'){
      if(a.voided && !/補登/.test(a.voidReason||'')) return;
      miss++; if(!a.voided) missOpen++;
      if(a.shift) keys.add(a.empName+'|'+day+'|'+a.shift);
      return;
    }
    if(a.voided || !a.shift || a.status==='到場' || (a.type!=='上班'&&a.type!=='下班')) return;
    keys.add(a.empName+'|'+day+'|'+a.shift);
    if(a.type==='上班'){ ins++; if(a.status==='遲到') late++; }
  });
  const req=(reqs||[]).length, shifts=keys.size;
  const pct=(a,b)=>b?Math.round(a/b*1000)/10:null;
  return {shifts, miss, missOpen, req, late, ins, missRate:pct(miss,shifts), reqRate:pct(req,shifts), lateRate:pct(late,ins)};
}
const DISC_COLS=[
  {k:'missRate', t:'缺卡率', fmt:d=>d.missRate==null?'—':d.missRate+'%', sub:d=>`${d.miss}/${d.shifts}班`},
  {k:'reqRate',  t:'補登率', fmt:d=>d.reqRate==null?'—':d.reqRate+'%',  sub:d=>`${d.req}件`},
  {k:'lateRate', t:'遲到率', fmt:d=>d.lateRate==null?'—':d.lateRate+'%', sub:d=>`${d.late}/${d.ins}次`},
  {k:'missOpen', t:'未處理缺卡', fmt:d=>String(d.missOpen), sub:()=>'張'},
];
function renderDiscipline(m,extra,only,bare){
  const rows=(only||STORES).filter(s=>extra[s]&&extra[s].disc);
  if(!rows.length) return '<div class="empty">本月尚無打卡資料</div>';
  // 每欄最差的那家標紅（越高越差）；未處理缺卡 >0 一律標紅
  const worst={}; if(rows.length>1) DISC_COLS.forEach(c=>{ let w=null; rows.forEach(s=>{ const v=extra[s].disc[c.k]; if(v!=null&&v>0&&(w==null||v>extra[w].disc[c.k])) w=s; }); worst[c.k]=w; });
  const cell=(s,c)=>{ const d=extra[s].disc, bad=(c.k==='missOpen')?d.missOpen>0:worst[c.k]===s;
    return `<td style="${bad?'color:#c5221f;font-weight:900;':''}">${c.fmt(d)}<div style="font-size:10.5px;color:var(--muted);font-weight:600;">${c.sub(d)}</div></td>`; };
  const tbl=`<div class="scroll"><table class="tbl"><thead><tr><th>門市</th>${DISC_COLS.map(c=>`<th>${c.t}</th>`).join('')}</tr></thead><tbody>${rows.map(s=>`<tr><td><b>${esc(s)}</b></td>${DISC_COLS.map(c=>cell(s,c)).join('')}</tr>`).join('')}</tbody></table></div>`;
  return `${bare?'':`<div class="sec-title">🕐 出勤紀律追蹤<span class="sec-sub">${m.split('-')[0]}年${+m.split('-')[1]}月</span></div>`}
  <div class="card">${tbl}
    <div style="font-size:11px;color:var(--muted);line-height:1.6;margin-top:8px;">缺卡率＝缺卡單÷班數（已補登的照算）；補登率＝補登申請÷班數${rows.length>1?'；紅字＝三店中最高':''}。</div>
    <div id="discTrend" style="margin-top:10px;"><button onclick="loadDisciplineTrend()" style="width:100%;padding:9px;background:#f1f5f9;border:none;border-radius:10px;font-size:13px;font-weight:800;color:var(--text);cursor:pointer;">📈 看近 6 個月趨勢</button></div>
  </div>`;
}
var discTrendCache={}, discTrendKey='missRate', discTrendMonths=[];
async function loadDisciplineTrend(){
  const box=document.getElementById('discTrend'); if(!box) return;
  box.innerHTML='<div class="empty">讀取中…</div>';
  const [y,mo]=dashMonth.split('-').map(Number), months=[];
  for(let i=5;i>=0;i--){ const d=new Date(y,mo-1-i,1); months.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`); }
  await Promise.all(months.flatMap(ym=>STORES.map(async s=>{
    const k=s+'|'+ym; if(discTrendCache[k]!==undefined) return;   // 單店時也一併抓三店（切回三店不用重讀）
    const c=dashCache[ym]&&dashCache[ym].extra[s];
    if(c&&c.disc){ discTrendCache[k]=c.disc; return; }
    try{ const a=await window.db.collection('stores').doc(s).collection('attendance').where('date','>=',ym+'-01').where('date','<=',ym+'-31').get();
      discTrendCache[k]=a.empty?null:disciplineOf(a.docs.map(d=>d.data()), await monthRequests(s,ym)); }
    catch(e){ discTrendCache[k]=null; }
  })));
  discTrendMonths=months;
  renderDisciplineTrend();
}
function renderDisciplineTrend(){
  const months=discTrendMonths;
  const box=document.getElementById('discTrend'); if(!box) return;
  const col=DISC_COLS.find(c=>c.k===discTrendKey)||DISC_COLS[0];
  const sel=`<select onchange="discTrendKey=this.value;renderDisciplineTrend()" style="padding:5px 7px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;font-weight:700;margin-bottom:8px;">${DISC_COLS.map(c=>`<option value="${c.k}"${c.k===col.k?' selected':''}>${c.t}</option>`).join('')}</select>`;
  const rows=months.map(ym=>`<tr><td>${ym}</td>${STORES.map(s=>{ const d=discTrendCache[s+'|'+ym]; return `<td>${d?col.fmt(d):'—'}</td>`; }).join('')}</tr>`).join('');
  box.innerHTML=sel+`<div class="scroll"><table class="tbl"><thead><tr><th>月份</th>${STORES.map(s=>`<th>${esc(s)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ===== 三店總覽 =====
function renderOverview(m,only){
  only=only||STORES;
  const my=ymMinus12(m);
  let net=0,rew=0,sur=0, netY=0,rewY=0,surY=0, rateNum=0,rateDen=0;
  let hasPrev=false;
  only.forEach(s=>{
    const pn=pnlOf(s,m), pf=perfOf(s,m);
    if(pn){ net+=n(pn.netSales); rew+=n(pn.operatingReward); }
    if(pn&&pf){ sur+=n(pn.operatingReward)-n(pf.laborCost); rateNum+=n(pf.laborCost); rateDen+=n(pn.netSales); }
    const pnY=pnlOf(s,my), pfY=perfOf(s,my);
    if(pnY){ netY+=n(pnY.netSales); rewY+=n(pnY.operatingReward); hasPrev=true; }
    if(pnY&&pfY){ surY+=n(pnY.operatingReward)-n(pfY.laborCost); }
  });
  const rate=rateDen>0?(rateNum/rateDen*100):null;
  // 上月（門市餘裕、人事費率沒有去年同期的人事資料，改跟上月比）
  const pm=prevYm(m); let surP=null, rateNP=0, rateDP=0;
  only.forEach(s=>{ const pn=pnlOf(s,pm), pf=perfOf(s,pm); if(pn&&pf){ surP=(surP||0)+n(pn.operatingReward)-n(pf.laborCost); rateNP+=n(pf.laborCost); rateDP+=n(pn.netSales); } });
  const rateP=rateDP>0?rateNP/rateDP*100:null;
  const mom=(cur,prev,txt,goodUp)=>{ if(prev==null||cur==null) return '<div class="kpi-yoy flat">—</div>'; const up=cur>prev; const good=goodUp?up:!up; return `<div class="kpi-yoy ${cur===prev?'flat':good?'up':'down'}">上月 ${txt(prev)}</div>`; };
  const ms=monthsUpTo(m,12);
  const spNet=sparkSvg(ms.map(x=>sumOf(only,x,(pn)=>pn&&n(pn.netSales))),'#1a73e8');
  const spRew=sparkSvg(ms.map(x=>sumOf(only,x,(pn)=>pn&&n(pn.operatingReward))),'#1a73e8');
  const spSur=sparkSvg(ms.map(x=>sumOf(only,x,(pn,pf)=>pn&&pf&&(n(pn.operatingReward)-n(pf.laborCost)))),'#c5221f',true);
  const spRate=sparkSvg(ms.map(x=>{ let a=0,b=0,ok=false; only.forEach(s=>{ const pn=pnlOf(s,x), pf=perfOf(s,x); if(pn&&pf){ a+=n(pf.laborCost); b+=n(pn.netSales); ok=true; } }); return ok&&b?a/b*100:null; }),'#e67e22');
  const yoy=(cur,prev)=>{ if(!hasPrev||!prev) return '<div class="kpi-yoy flat">—</div>'; const d=cur-prev; const p=prev?Math.round(d/Math.abs(prev)*1000)/10:0; const cls=d>0?'up':d<0?'down':'flat'; const ar=d>0?'▲':d<0?'▼':'—'; return `<div class="kpi-yoy ${cls}">${ar} ${p>0?'+':''}${p}% vs 去年同期</div>`; };
  const one=only.length===1, P=one?'':'全體';
  return `<div class="sec-title">${one?'🏪 '+only[0]:'🏪 三店總覽'}<span class="sec-sub">${m.split('-')[0]}年${+m.split('-')[1]}月${one?'':' · 全體合計'}</span></div>
  <div class="kpi-grid" style="margin-bottom:10px;">
    <div class="kpi"><div class="kpi-label">${P}營業淨額</div><div class="kpi-val">${wan(net)}</div>${yoy(net,netY)}${spNet}</div>
    <div class="kpi"><div class="kpi-label">${P}經營報酬</div><div class="kpi-val">${wan(rew)}</div>${yoy(rew,rewY)}${spRew}</div>
    <div class="kpi"><div class="kpi-label">${P}門市餘裕<span style="font-weight:600;color:var(--muted);">(含支援)</span></div><div class="kpi-val" style="color:${sur>=0?'#137333':'#c5221f'}">${wan(sur)}</div>${mom(sur,surP,wan,true)}${spSur}</div>
    <div class="kpi"><div class="kpi-label">${one?'人事費率':'平均人事費率'}</div><div class="kpi-val">${rate!=null?rate.toFixed(1)+'%':'—'}</div>${mom(rate,rateP,v=>v.toFixed(1)+'%',false)}${spRate}</div>
  </div>`;
}

// ===== 店長管理力計分卡（benchmark 對標分數 0-100 × 權重；獲益優先）=====
function renderScorecard(m,extra,mode){
  const clamp=x=>Math.max(0,Math.min(100,x));
  // 💰 獲利貢獻＝率分×0.7＋額分×0.3。純比率會讓不同規模的店在天花板上同分
  //（2026-08：聯鑫 $96,369 與美德 $49,075 餘裕率同為 2.5% → 都是 100 分），故納入絕對金額。
  const SURPLUS_FULL=100000;   // 餘裕金額拿滿分的門檻
  const SURPLUS_RATE_FULL=4;   // 餘裕率拿滿分的門檻(%)，原為 2.5% 太低
  const surplusSc=(v,r)=>{
    const rateSc=clamp(50+v*(50/SURPLUS_RATE_FULL));
    const absSc=(r.surplusAbs!=null)?clamp(r.surplusAbs/SURPLUS_FULL*100):null;
    return absSc==null?rateSc:rateSc*0.7+absSc*0.3;
  };
  const rows=STORES.map(s=>{
    const pn=pnlOf(s,m), pf=perfOf(s,m), ex=extra[s]||{};
    const net=pn?n(pn.netSales):null, labor=pf?n(pf.laborCost):null, hours=pf?n(pf.totalHours):null, rew=pn?n(pn.operatingReward):null;
    const pnY=pnlOf(s,ymMinus12(m)), pfY=perfOf(s,ymMinus12(m));
    const netY=pnY?n(pnY.netSales):null, laborY=pfY?n(pfY.laborCost):null;
    const head=ex.head||null;
    const curRate=(labor!=null&&net)? labor/net*100 : null;
    const rateY=(laborY!=null&&netY)? laborY/netY*100 : null;
    // 淨損耗率 =（壞品 − 攤提盤損 ＋ 現金短少）÷ 營收；盤損按盤點區間攤提，故無盤點月也可比
    const am=amortOf(s,m);
    const lossRate=window.PnlLoss?window.PnlLoss.lossRate(pn,am):null;
    return {
      s, net, rew, head, turnover:ex.turnover, late:ex.late, law:ex.law, amort:am,
      perHr:(net!=null&&hours)? net/hours : null,
      surplusAbs:(rew!=null&&labor!=null)? rew-labor : null,
      surplusRate:(rew!=null&&labor!=null&&net)? (rew-labor)/net*100 : null,        // 餘裕率(貢獻率)
      lossRate,                                                                     // 淨損耗率
      laborRate:curRate,
      laborImprove:(curRate!=null&&rateY!=null)? (rateY-curRate) : null,
      salesYoY:(net!=null&&netY)? (net-netY)/Math.abs(netY)*100 : null,
      lateRate:(ex.late!=null&&head)? ex.late/head : null,
    };
  });
  // 每維度：val 取值、sc benchmark 0-100 分數、w 權重（獲益優先）
  const dims=[
    {key:'surplusRate', w:1.3, ic:'💰', name:'獲利貢獻（餘裕率×金額）', val:r=>r.surplusRate, sc:surplusSc, fmt:v=>`餘裕率 ${v>=0?'+':''}${v.toFixed(1)}%`, sub:r=>`餘裕 $${r.surplusAbs!=null?money(r.surplusAbs):'—'}（未扣稅/水電/租金）· 率分 ${Math.round(clamp(50+r.surplusRate*(50/SURPLUS_RATE_FULL)))}×0.7 ＋ 額分 ${r.surplusAbs!=null?Math.round(clamp(r.surplusAbs/SURPLUS_FULL*100)):'—'}×0.3`},
    {key:'lossRate', w:1.0, ic:'🛡️', name:'損耗控制（淨損耗率）', val:r=>r.lossRate, sc:v=>clamp(100-Math.max(0,v-1)/0.5*15), fmt:v=>`淨損耗率 ${v.toFixed(2)}%`, sub:r=>`壞品＋盤損＋現金短少 ÷ 營收（越低越好）· ${window.PnlLoss?window.PnlLoss.note(r.amort):''}`},
    {key:'salesYoY', w:1.0, ic:'📈', name:'業績成長（營收YoY）', val:r=>r.salesYoY, sc:v=>clamp(50+v*5), fmt:v=>`營收 YoY ${v>0?'+':''}${v.toFixed(1)}%`, sub:r=>`本月營收 $${r.net!=null?money(r.net):'—'}`},
    {key:'laborRate', w:0.6, ic:'📐', name:'人事費率水準', val:r=>r.laborRate, sc:v=>clamp(100-Math.max(0,v-9)*10), fmt:v=>`人事費率 ${v.toFixed(1)}%`, sub:r=>'含公司負擔÷營業淨額（越低越好）'},
    {key:'law', w:0.3, ic:'⚖️', name:'合規紀律', val:r=>r.law, sc:v=>clamp(100-v*15), fmt:v=>`知情放行 ${v} 次`, sub:r=>'越少越守法'},
    {key:'lateRate', w:0.3, ic:'⏰', name:'團隊出勤紀律（每人）', val:r=>r.lateRate, sc:v=>clamp(100-v/0.5*20), fmt:v=>`出勤異常 ${v.toFixed(2)} 次/人`, sub:r=>`遲到/早退/缺卡 ${r.late!=null?r.late:'—'} 次 · ${r.head||'—'} 人`},
    {key:'perHr', w:0.3, ic:'🏭', name:'坪效（每工時營收）', val:r=>r.perHr, sc:v=>clamp(50+(v-1500)/100*4), fmt:v=>`每工時營收 $${money(v)}`, sub:r=>'營業淨額÷總工時'},
    {key:'laborImprove', w:0.6, ic:'📉', name:'人事費率改善（同期）', val:r=>r.laborImprove, sc:v=>clamp(50+v*15), fmt:v=>`費率同期 ${v>=0?'↓改善 '+v.toFixed(1):'↑惡化 '+Math.abs(v).toFixed(1)}pt`, sub:r=>'需去年同期人事資料'},
  ];
  // 計分：benchmark 分數 × 權重 加總
  const total={}, scMap={}; STORES.forEach(s=>{total[s]=0;scMap[s]={};});
  rows.forEach(r=>{ dims.forEach(d=>{ const v=d.val(r); const sc=(v!=null)?d.sc(v,r):null; scMap[r.s][d.key]=sc; if(sc!=null) total[r.s]+=sc*d.w; }); });
  const placeOf=s=>1+STORES.filter(o=>total[o]>total[s]).length;
  const ranked=[...STORES].sort((a,b)=>total[b]-total[a]);
  const scColor=sc=> sc==null?'#cbd5e1' : sc>=75?'#137333' : sc<40?'#c5221f':'#334155';

  // 摘要：主畫面只給名次、總分與最弱一項，細節進獨立檢視看（原本整張表＋每店明細塞在首屏，太滿）
  if(mode==='store'){
    const s=arguments[3], r=rows.find(x=>x.s===s); if(!r) return '<div class="empty">無資料</div>';
    let h=`<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;"><span style="font-size:13px;font-weight:800;">第 ${placeOf(s)} 名・總分 ${Math.round(total[s])}</span><button class="mini-btn" style="margin-left:auto;" onclick="openScoreHelp()">ℹ️ 指標說明</button></div>`;
    dims.forEach(d=>{ const v=d.val(r), sc=scMap[s][d.key];
      h+=`<div class="dim-row"><div class="dim-ic">${d.ic}</div><div class="dim-body"><div class="dim-name">${d.name} <span style="font-size:10px;color:var(--muted);font-weight:800;">×${d.w}</span> ${sc!=null?`<span style="font-weight:900;color:${scColor(sc)}">${Math.round(sc)}分</span>`:''}</div><div class="dim-sub">${v!=null?d.fmt(v):'<span style="color:#cbd5e1;">資料累積中</span>'}${v!=null?' · '+d.sub(r):''}</div></div></div>`; });
    return h+`<button class="sc-more" onclick="openScoreView()">看三店完整計分卡 ›</button>`;
  }
  if(mode==='rank'){ return {ranked, total, placeOf}; }
  if(mode==='summary'||mode==='body'){
    const worstOf=s=>{
      let w=null;
      dims.forEach(d=>{ const sc=scMap[s][d.key]; if(sc==null) return; if(!w||sc<w.sc) w={sc,d}; });
      return w;
    };
    let sum=mode==='body'?'<div>':`<div class="sec-title">👔 店長管理力計分卡</div><div class="card">`;
    ranked.forEach(s=>{
      const pl=placeOf(s), w=worstOf(s), mgr=(extra[s]&&extra[s].mgr)||'';
      sum+=`<div class="sc-row">`
        +`<div class="sc-rank">${pl===1?'🏆':pl}</div>`
        +`<div class="sc-name">${s}${mgr?`<span class="sc-mgr">${mgr}</span>`:''}`
        +(w?`<div class="sc-weak">最弱：${w.d.ic} ${w.d.name}（${Math.round(w.sc)} 分）</div>`:'')
        +`</div>`
        +`<div class="sc-total" style="color:${scColor(total[s]/dims.reduce((a,d)=>a+d.w,0))}">${Math.round(total[s])}</div>`
        +`</div>`;
    });
    sum+=`<button class="sc-more" onclick="openScoreView()">看完整計分卡（各指標分數與明細）›</button></div>`;
    return sum;
  }

  let head=`<div class="sec-title">👔 店長管理力計分卡<button onclick="openScoreHelp()" style="background:#4338ca;color:#fff;border:none;border-radius:8px;padding:5px 11px;font-size:12px;font-weight:800;cursor:pointer;white-space:nowrap;">ℹ️ 指標說明</button><span class="sec-sub">對標分數×權重・獲益優先</span></div>`;
  let tbl=`<div class="card scroll"><table class="tbl"><thead><tr><th>門市（店長）</th>${dims.map(d=>`<th>${d.ic}</th>`).join('')}<th>總分</th><th>名次</th></tr></thead><tbody>`;
  ranked.forEach((s)=>{
    const mgr=(extra[s]&&extra[s].mgr)||''; const pl=placeOf(s);
    tbl+=`<tr class="${pl===1?'rank1':''}"><td>${s}${mgr?`<div style="font-size:10.5px;color:var(--muted);font-weight:600;">${mgr}</div>`:''}</td>`;
    dims.forEach(d=>{ const sc=scMap[s][d.key]; tbl+=`<td style="font-weight:800;color:${scColor(sc)}">${sc!=null?Math.round(sc):'—'}</td>`; });
    tbl+=`<td style="font-weight:900;">${Math.round(total[s])}</td><td>${pl===1?'🏆':pl}</td></tr>`;
  });
  tbl+=`</tbody></table><div style="font-size:10.5px;color:var(--muted);margin-top:6px;">格內為該指標 0–100 對標分數（非名次）；總分＝各分數×權重加總。</div></div>`;

  let detail='';
  ranked.forEach((s)=>{
    const r=rows.find(x=>x.s===s);
    // 上面的總表已經把每店每個指標的分數列過一次，明細若也攤開就是同樣數字看兩遍 →
    // 收進 <details>，要看「為什麼是這個分數」才點開（原生元素，不必寫 JS）。
    detail+=`<details class="dim-fold"><summary><span style="width:10px;height:10px;border-radius:50%;background:${STORE_COLORS[s]||'#888'};flex-shrink:0;"></span><span style="font-size:15px;font-weight:900;">${s}</span><span style="font-size:12px;color:var(--muted);font-weight:700;">${(extra[s]&&extra[s].mgr)||''}</span><span style="margin-left:auto;font-size:12px;font-weight:800;color:var(--primary);">總分 ${Math.round(total[s])}（第 ${placeOf(s)} 名）</span></summary>`;
    dims.forEach(d=>{
      const v=d.val(r), sc=scMap[s][d.key];
      detail+=`<div class="dim-row"><div class="dim-ic">${d.ic}</div><div class="dim-body"><div class="dim-name">${d.name} <span style="font-size:10px;color:var(--muted);font-weight:800;">×${d.w}</span> ${sc!=null?`<span style="font-weight:900;color:${scColor(sc)}">${Math.round(sc)}分</span>`:''}</div><div class="dim-sub">${v!=null?d.fmt(v):'<span style="color:#cbd5e1;">資料累積中</span>'}${v!=null?' · '+d.sub(r):''}</div></div></div>`;
    });
    detail+=`</details>`;
  });
  return head+tbl+`<div class="note" style="margin-bottom:10px;">點門市可以展開，看每個指標的分數是怎麼來的。</div>`+detail;
}
// ===== 未休假獎金估算（2026-10-10）=====
// 使用者定案：特休＋補休一起算；顯示「到期月份結算」的金額，可遞延的標註；過期沒處理的列進「要處理」；排除加盟主本人。
// 規則（同 leave-page.js）：
//  ・特休批次 expireDate 到期 → 店長選「結算薪資」或「遞延一年」；遞延過的（carried）到期＋12 個月必須結算
//  ・補休年底（12/31）結算或遞延到隔年底一次；餘額從帳本算（comp-avail.js，comp/{年} 統計欄位會漂）
//  ・日薪＝最近一次薪資記錄的（底薪＋全勤）÷30（同 leave-settle.js／calcCarrySettlement）；工讀以時薪×8 估
// 這是「到期前都沒休」的上限，員工休掉的部分會減少。
let leaveEst=null;
function lvAddMonths(ymd,k){ const [y,m]=ymd.split('-').map(Number); const d=new Date(y,m-1+k,1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
async function loadLeaveEstimate(){
  const today=new Date(), curYm=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}`, yr=today.getFullYear();
  const emps=[];
  for(const s of STORES){
    try{ const es=await window.db.collection('stores').doc(s).collection('employees').get();
      es.forEach(d=>{ const e=d.data()||{};
        if(e.role==='加盟主') return;                                   // 使用者 2026-10-10：排除加盟主本人
        if(['離職','調走'].includes(e.status||'')) return;              // 離職／調走走結清流程，不在這裡估
        emps.push({name:d.id, store:s, role:e.role||'', disp:e.displayName||d.id, payAsPartTime:!!e.payAsPartTime}); });
    }catch(e){}
  }
  // 日薪：該店最近兩個月的薪資記錄
  const recOf={};
  for(const s of STORES){ for(const ym of [prevYm(curYm), prevYm(prevYm(curYm))]){
    try{ const sn=await window.db.collection('stores').doc(s).collection('salary').doc(ym).get();
      if(sn.exists)(sn.data().records||[]).forEach(r=>{ if(r&&r.empName&&!recOf[r.empName]) recOf[r.empName]=r; }); }catch(e){} } }
  const items=[];
  await Promise.all(emps.map(async e=>{
    const r=recOf[e.name]||{};
    const part=e.role==='工讀'||e.payAsPartTime||r.role==='工讀'||r.payAsPartTime;
    const dw=part ? n(r.wage)*8 : (n(r.baseSalary)+n(r.fullAttendBonus))/30;
    const base={store:e.store, emp:e.name, disp:e.disp, dw:Math.round(dw), noWage:!(dw>0)};
    try{
      const bs=await window.db.collection('employees').doc(e.name).collection('leaveBatches').get();
      bs.forEach(d=>{ const b=d.data()||{};
        if(b.settled||!b.expireDate) return;
        const rem=Math.max(0,n(b.days)-n(b.used)); if(!rem) return;
        const due=b.carried?lvAddMonths(b.expireDate,12):b.expireDate.slice(0,7);
        items.push(Object.assign({kind:'特休', label:b.label||b.note||'', days:rem, due, canCarry:!b.carried, mustSettle:!!b.carried, overdue:due<curYm, amt:Math.round(rem*dw)},base));
      });
    }catch(err){}
    try{
      if(window.caCompAvailability){
        const ca=await caCompAvailability(e.name);
        const rem=Math.max(0,ca.balance||0);
        if(rem>0) items.push(Object.assign({kind:'補休', label:`${yr} 年度`, days:rem, due:`${yr}-12`, canCarry:true, mustSettle:false, overdue:false, amt:Math.round(rem*dw)},base));
      }
    }catch(err){}
  }));
  leaveEst={items, curYm, at:Date.now()};
}
var lvPick='';
function renderLeaveEstimate(scope){
  const title=`<div class="chart-t">🏖️ 未休假獎金估算</div><div class="chart-s">未來 12 個月・假設到期前都沒休、到期就結算（上限）・不含加盟主</div>`;
  if(!leaveEst) return `<div class="chart-card">${title}<div class="empty">計算中…（要讀每個人的特休與補休）</div></div>`;
  const items=leaveEst.items.filter(x=>!scope||x.store===scope);
  const months=[]; let x=leaveEst.curYm; for(let i=0;i<12;i++){ months.push(x); x=lvAddMonths(x+'-01',1); }
  const inWin=items.filter(i=>months.includes(i.due)), od=items.filter(i=>i.overdue);
  const sum=(arr,k)=>arr.filter(i=>i.kind===k).reduce((a,i)=>a+i.amt,0);
  const total=inWin.reduce((a,i)=>a+i.amt,0);
  const chart=queueChart('chLeave',{ type:'bar', data:{ labels:months.map(m=>(m.slice(5)==='01'?m.slice(2,4)+'/':'')+(+m.slice(5))+'月'), datasets:[
    { label:'特休', data:months.map(m=>Math.round(sum(inWin.filter(i=>i.due===m),'特休'))), backgroundColor:'#1a73e8', borderRadius:3, stack:'a' },
    { label:'補休', data:months.map(m=>Math.round(sum(inWin.filter(i=>i.due===m),'補休'))), backgroundColor:'#e67e22', borderRadius:3, stack:'a' } ] },
    options:chartOpts(v=>'$'+money(v),{ scales:{ x:{stacked:true,ticks:{font:{size:10}},grid:{display:false}}, y:{stacked:true,ticks:{callback:v=>v>=10000?(v/10000)+'萬':v,font:{size:10}},grid:{color:'#f1f5f9'}} },
      onClick:(ev,els)=>{ if(!els.length) return; lvPick=months[els[0].index]; renderLeaveDetail(scope); } }) });
  const odHtml=od.length?`<div style="background:#fff3e0;border-radius:10px;padding:8px 11px;margin:8px 0 2px;font-size:12px;font-weight:700;color:#c0620f;">⚠️ 已過期但沒結算也沒遞延 ${od.length} 筆（${od.reduce((a,i)=>a+i.days,0)} 天、約 $${money(od.reduce((a,i)=>a+i.amt,0))}），請到特休頁處理</div>`:'';
  if(!lvPick||!months.includes(lvPick)){ const firstDue=months.find(m=>inWin.some(i=>i.due===m)); lvPick=firstDue||months[0]; }
  setTimeout(()=>renderLeaveDetail(scope),0);
  return `<div class="chart-card">${title}
    <div style="font-size:13px;font-weight:800;margin-bottom:6px;">合計約 <span style="font-size:17px;">$${money(total)}</span><span style="font-size:11.5px;color:var(--muted);font-weight:600;">（特休 $${money(sum(inWin,'特休'))}・補休 $${money(sum(inWin,'補休'))}）</span></div>
    ${chart}${odHtml}<div id="lvDetail" style="margin-top:8px;"></div>
    <div style="font-size:11px;color:var(--muted);margin-top:6px;line-height:1.6;">點長條看該月明細。日薪＝最近一次薪資的（底薪＋全勤）÷30；工讀以時薪×8 估。「可遞延」＝到期時可選遞延一年，金額會移到隔年。</div></div>`;
}
function renderLeaveDetail(scope){
  const el=document.getElementById('lvDetail'); if(!el||!leaveEst) return;
  const list=leaveEst.items.filter(x=>(!scope||x.store===scope)&&x.due===lvPick).sort((a,b)=>b.amt-a.amt);
  if(!list.length){ el.innerHTML=`<div style="font-size:12px;color:var(--muted);">${+lvPick.slice(5)}月沒有到期的特休或補休</div>`; return; }
  const showAll=el.dataset.all===lvPick, shown=showAll?list:list.slice(0,5);
  el.innerHTML=`<div style="font-size:12.5px;font-weight:900;margin-bottom:2px;">${lvPick.slice(0,4)}年${+lvPick.slice(5)}月到期・${list.length} 筆・約 $${money(list.reduce((a,i)=>a+i.amt,0))}</div>`+shown.map(i=>`<div class="lv-row">
    <span style="font-weight:800;min-width:56px;">${esc(i.disp)}</span><span style="color:var(--muted);font-size:11.5px;">${i.store}</span>
    <span class="lv-tag" style="background:${i.kind==='特休'?'#e8f0fe':'#fff3e0'};color:${i.kind==='特休'?'#1a56c4':'#c0620f'};">${i.kind}${i.label?'・'+esc(i.label):''}</span>
    <span style="margin-left:auto;white-space:nowrap;">${i.days} 天${i.noWage?'':' × $'+money(i.dw)}</span>
    <b style="min-width:62px;text-align:right;">${i.noWage?'缺薪資':'$'+money(i.amt)}</b>
    <span class="lv-tag" style="background:${i.mustSettle?'#fce8e6':'#f1f5f9'};color:${i.mustSettle?'#c5221f':'#64748b'};">${i.mustSettle?'必須結算':'可遞延'}</span></div>`).join('')
    +(list.length>5&&!showAll?`<button class="sc-more" style="margin-top:6px;padding:7px;" onclick="document.getElementById('lvDetail').dataset.all=lvPick;renderLeaveDetail(OwnerScope.get())">看全部 ${list.length} 筆</button>`:'');
}

// ===== 這個月要處理（2026-10-10 取代原本一條條的決策警示，改成依門市分組）=====
// 去掉「本月遲到/缺卡 N 次 ≥5」：三店每月都觸發（46／108／86），而且把已補登的也算進去，等於沒有參考價值。
// 改看遲到率與「還沒處理的缺卡單」。
function collectAlerts(m,extra){
  const out={};
  STORES.forEach(s=>{
    const pn=pnlOf(s,m), pf=perfOf(s,m), ex=extra[s]||{}, L=out[s]=[];
    if(pn&&pf){ const sur=n(pn.operatingReward)-n(pf.laborCost); if(sur<0) L.push({sev:'red',t:'門市餘裕為負',v:money(sur)}); }
    if(pn&&pf&&n(pn.netSales)){ const rate=n(pf.laborCost)/n(pn.netSales)*100; if(rate>35) L.push({sev:'red',t:'人事費率偏高',v:rate.toFixed(1)+'%'}); }
    if(pn&&n(pn.netSales)&&n(pn.badGoodsCost)){ const br=n(pn.badGoodsCost)/n(pn.netSales)*100; if(br>3) L.push({sev:'warn',t:'壞品率偏高',v:br.toFixed(1)+'%'}); }
    if(window.PnlLoss){ const am=amortOf(s,m), lr=window.PnlLoss.lossRate(pn,am); if(lr!=null&&lr>2.5) L.push({sev:'warn',t:'淨損耗率偏高',v:lr.toFixed(2)+'%'}); }
    if(ex.disc&&ex.disc.missOpen>=10) L.push({sev:'warn',t:'缺卡單還沒處理',v:ex.disc.missOpen+' 張'});
    if(ex.disc&&ex.disc.lateRate!=null&&ex.disc.lateRate>10) L.push({sev:'warn',t:'遲到率偏高',v:ex.disc.lateRate+'%'});
    if(ex.law>=3) L.push({sev:'warn',t:'排班知情放行',v:ex.law+' 次'});
    const od=leaveEst?leaveEst.items.filter(x=>x.store===s&&x.overdue):[];
    if(od.length) L.push({sev:'warn',t:'特休／補休過期未處理',v:od.length+' 筆'});
    L.sort((a,b)=>(a.sev==='red'?0:1)-(b.sev==='red'?0:1));
  });
  return out;
}
function renderTodo(m,al,scope){
  const ttl=`<div class="sec-title">🚦 ${scope?scope+' ':''}這個月要處理<span class="sec-sub">${m.split('-')[0]}年${+m.split('-')[1]}月</span></div>`;
  if(scope){
    const L=al[scope]||[];
    if(!L.length) return ttl+`<div class="card"><div class="todo-line"><span>✅ 本月沒有需要處理的警示</span></div></div>`;
    return ttl+`<div class="card" style="border-left:4px solid ${L.some(x=>x.sev==='red')?'#c5221f':'#e67e22'};">${L.map(x=>`<div class="todo-line"><span>${x.t}</span><span class="todo-cnt ${x.sev==='red'?'sev-red':'sev-warn'}">${x.v}</span></div>`).join('')}</div>`;
  }
  const order=STORES.slice().sort((a,b)=>{ const sc=s=>(al[s]||[]).reduce((t,x)=>t+(x.sev==='red'?10:1),0); return sc(b)-sc(a); });
  const rows=order.map(s=>{ const L=al[s]||[], red=L.some(x=>x.sev==='red');
    return `<div class="todo-row" onclick="OwnerScope.set('${s}')"><span class="todo-name">${s}</span><span class="todo-items">${L.length?L.map(x=>x.t).join('・'):'沒有警示'}</span><span class="todo-cnt ${!L.length?'sev-ok':red?'sev-red':'sev-warn'}">${L.length?L.length+' 項':'✓'}</span><span style="color:#94a3b8;font-size:18px;">›</span></div>`; }).join('');
  return ttl+`<div class="card">${rows}<div style="font-size:11px;color:var(--muted);margin-top:6px;">點門市看那一家的細節</div></div>`;
}
function scoreSummary(m,extra,scope){
  const r=renderScorecard(m,extra,'rank');
  if(!r||!r.ranked||!r.ranked.length) return '';
  return scope?`第 ${r.placeOf(scope)} 名・${Math.round(r.total[scope])} 分`:`${r.ranked[0]} 第一・${Math.round(r.total[r.ranked[0]])} 分`;
}

// ===== 指標與計分說明（給加盟主） =====
function closeScoreHelp(){ const el=document.getElementById('scoreHelpOverlay'); if(el) el.remove(); }
function openScoreHelp(){
  closeScoreHelp();
  const item=(ic,name,desc)=>`<div style="display:flex;gap:9px;padding:9px 0;border-bottom:1px solid #f1f5f9;"><div style="font-size:18px;line-height:1.4;">${ic}</div><div style="flex:1;"><div style="font-weight:800;font-size:13.5px;margin-bottom:2px;">${name}</div><div style="font-size:12px;color:#475569;line-height:1.65;">${desc}</div></div></div>`;
  const wt=(label,w,why)=>`<div style="display:flex;gap:8px;padding:6px 0;font-size:12px;"><div style="min-width:118px;font-weight:800;">${label}</div><div style="min-width:44px;font-weight:900;color:#4338ca;">×${w}</div><div style="flex:1;color:#475569;line-height:1.6;">${why}</div></div>`;
  const html=`
  <div style="font-size:17px;font-weight:900;margin-bottom:4px;">👔 計分卡指標說明</div>
  <div style="font-size:12px;color:#64748b;margin-bottom:12px;line-height:1.6;"><b>計分方式</b>：每個指標對「<b>固定標準</b>」打 <b>0–100 分</b>（不是跟另兩家比名次），再 <b>× 權重</b> 加總排名。好處：分數直接反映「多好/多差」，又不會被單一離群值或單月異常扭曲。整體<b>以加盟主獲益為優先</b>。</div>

  <div style="font-weight:900;font-size:13px;color:#4338ca;margin:6px 0 2px;">📌 各指標代表什麼</div>
  ${item('💰','獲利貢獻（餘裕率×金額）','（經營報酬 − 含支援人事成本）÷ 營收＝門市替加盟主留下的貢獻率。<b>正＝賺、負＝虧</b>，虧損自然低分。⚠️此為「門市貢獻率」，<b>未扣稅/水電/租金，非最終淨利</b>——這些非店長可控，排除較公平。')}
  ${item('🛡️','損耗控制（淨損耗率）','（壞品＋盤損＋現金短少）÷ 營收。店長最可控、最直接侵蝕獲利的破口（越低越好）。盤點約 60~90 天一次，盤損會平均攤到它涵蓋的每個月（整筆記在盤點當月的話，該月店長要背整個區間、其他月份又虛高）；還沒盤點的區間先沿用上次的月均估算，所以無盤點的月份一樣有分數、也能跟盤點月互相比較。')}
  ${item('📈','業績成長（營收 YoY）','本月營收 vs <b>去年同月</b>成長率。同月比同月，消除規模與淡旺季，衡量把生意做大的能力。')}
  ${item('📐','人事費率水準','人事成本 ÷ 營收。超商最關鍵的成本指標，越低越有效率（可直接跨店比）。')}
  ${item('⚖️','合規紀律','排班觸犯勞基法軟性規則、店長「知情放行」次數，越少越守法。')}
  ${item('⏰','團隊出勤紀律（每人）','遲到／早退／缺卡 ÷ 人數，用「每人」正規化避免大店吃虧。')}
  ${item('🏭','坪效（每工時營收）','營收 ÷ 總工時，衡量人力生產力。')}
  ${item('📉','人事費率改善（同期）','人事費率 vs 去年同月降了多少。需去年同期人事資料，2025 年尚無、將於累積後啟用。')}

  <div style="font-weight:900;font-size:13px;color:#4338ca;margin:14px 0 2px;">⚖️ 權重（獲益優先）</div>
  ${wt('💰 獲利貢獻(餘裕率×金額)',1.3,'加盟主實際貢獻，最重要 → 最高。率分七成＋金額分三成，避免大小店在天花板同分。')}
  ${wt('🛡️ 損耗控制',1.0,'最可控、直接吃獲利。')}
  ${wt('📈 業績成長',1.0,'把餅做大＝未來獲益。')}
  ${wt('📐 人事費率水準',0.6,'最大可控成本(部分已在餘裕率)。')}
  ${wt('⚖️ 合規 / ⏰ 出勤',0.3,'風險與團隊管理，屬過程指標故低於獲益指標。')}
  ${wt('🏭 坪效',0.3,'生產力(輔助)。')}
  ${wt('📉 費率改善',0.6,'同期效率(資料累積中)。')}

  <div style="font-size:11px;color:#94a3b8;margin-top:12px;line-height:1.6;">＊分數對標固定標準：人事費率≤9%＝100 分、淨損耗率≤1%＝100 分；💰獲利貢獻的滿分門檻是<b>餘裕率 4%</b>與<b>餘裕金額 $100,000</b>（率分每 ±1%＝±12.5 分）。缺去年同期或打卡資料顯示「資料累積中」不計分。標準與權重可依加盟主偏好調整。</div>
  <button onclick="closeScoreHelp()" style="width:100%;margin-top:14px;padding:11px;background:var(--primary,#e67e22);color:#fff;border:none;border-radius:10px;font-weight:800;font-size:14px;cursor:pointer;">我了解了</button>`;
  const ov=document.createElement('div');
  ov.id='scoreHelpOverlay';
  ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9600;display:flex;align-items:center;justify-content:center;padding:16px;';
  ov.onclick=(e)=>{ if(e.target===ov) closeScoreHelp(); };
  ov.innerHTML=`<div style="background:#fff;border-radius:16px;max-width:440px;width:100%;max-height:88vh;overflow:auto;padding:20px;">${html}</div>`;
  document.body.appendChild(ov);
}
// ===== 本月營運檢討（管理者手寫 Markdown；可產生 3 天有效的分享連結）=====
let _reviewEditM=null;
function renderReview(m, review, bare){
  const text=(review&&review.text)?review.text:'';
  const canEdit=isOwner();
  const btns=canEdit?`<span style="margin-left:auto;display:flex;gap:6px;">
    <button class="mini-btn" onclick="openReviewEdit('${m}')">✏️ ${text?'編輯':'撰寫'}</button>
    ${text?`<button class="mini-btn" style="background:#e0f2fe;color:#0369a1;" onclick="openShareModal('${m}')">🔗 分享(3天)</button>`:''}
  </span>`:'';
  const body=text?`<div class="review-body">${mdToHtml(text)}</div><div style="font-size:10.5px;color:var(--muted);margin-top:10px;">最後更新：${review.updatedByName||review.updatedBy||''} ${String(review.updatedAt||'').slice(0,16).replace('T',' ')}</div>`
    :`<div class="empty">本月檢討尚未填寫${canEdit?'（點右上「撰寫」）':''}</div>`;
  if(bare) return `${canEdit?`<div style="display:flex;margin-bottom:8px;">${btns}</div>`:''}<div class="card">${body}</div>`;
  return `<div class="sec-title">📋 本月營運檢討<span class="sec-sub">${m.split('-')[0]}年${+m.split('-')[1]}月</span>${btns}</div><div class="card">${body}</div>`;
}
async function openReviewEdit(m){
  _reviewEditM=m; let cur='';
  try{ const rd=await window.db.collection('monthlyReviews').doc(m).get(); if(rd.exists) cur=rd.data().text||''; }catch(e){}
  const ov=document.createElement('div'); ov.id='reviewEditOverlay';
  ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9600;display:flex;align-items:center;justify-content:center;padding:14px;';
  ov.innerHTML=`<div style="background:#fff;border-radius:16px;max-width:560px;width:100%;max-height:92vh;overflow:auto;padding:18px;">
    <div style="font-size:16px;font-weight:900;margin-bottom:4px;">✏️ ${m} 營運檢討</div>
    <div style="font-size:11.5px;color:#64748b;margin-bottom:10px;line-height:1.6;">支援 Markdown：<code># 大標</code>／<code>## 中標</code>／<code>### 小標</code>／<code>- 項目</code>／<code>**粗體**</code>／<code>---</code> 分隔線。可直接貼上寫好的檢討。</div>
    <textarea id="reviewText" style="width:100%;height:46vh;padding:11px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:13px;font-family:inherit;line-height:1.7;resize:vertical;">${esc(cur)}</textarea>
    <div style="display:flex;gap:8px;margin-top:12px;">
      <button onclick="closeReviewEdit()" style="flex:1;padding:11px;background:#eef1f4;border:none;border-radius:10px;font-weight:700;cursor:pointer;">取消</button>
      <button onclick="saveReview()" style="flex:1;padding:11px;background:var(--primary,#e67e22);color:#fff;border:none;border-radius:10px;font-weight:800;cursor:pointer;">儲存</button>
    </div></div>`;
  ov.onclick=e=>{ if(e.target===ov) closeReviewEdit(); };
  document.body.appendChild(ov);
}
function closeReviewEdit(){ const el=document.getElementById('reviewEditOverlay'); if(el) el.remove(); }
async function saveReview(){
  const m=_reviewEditM, text=document.getElementById('reviewText').value;
  try{
    await window.db.collection('monthlyReviews').doc(m).set({ ym:m, text,
      updatedBy:(currentUser.empName||''), updatedByName:(currentUser.displayName||currentUser.empName||''), updatedAt:new Date().toISOString() },{merge:true});
    closeReviewEdit(); renderAll(m);
  }catch(e){ alert('儲存失敗：'+e.message); }
}
function reviewSnapshot(m){
  const my=ymMinus12(m);
  let net=0,rew=0,sur=0,rateNum=0,rateDen=0,netY=0,hasLabor=false,hasPrev=false;
  const stores=STORES.map(s=>{
    const pn=pnlOf(s,m), pf=perfOf(s,m), pnY=pnlOf(s,my), am=amortOf(s,m);
    const netS=pn?n(pn.netSales):null, labor=pf?n(pf.laborCost):null, hrs=pf?n(pf.totalHours):null, rewS=pn?n(pn.operatingReward):null;
    if(pn){ net+=n(pn.netSales); rew+=n(pn.operatingReward); }
    if(pn&&pf){ sur+=n(pn.operatingReward)-n(pf.laborCost); rateNum+=n(pf.laborCost); rateDen+=n(pn.netSales); hasLabor=true; }
    if(pnY){ netY+=n(pnY.netSales); hasPrev=true; }
    return { s, netSales:netS, salesYoY:(netS!=null&&pnY&&n(pnY.netSales))?(netS-n(pnY.netSales)):null,
      grossMargin:pn?n(pn.grossMargin):null, laborRate:(labor!=null&&netS)?labor/netS*100:null,
      perHr:(netS!=null&&hrs)?Math.round(netS/hrs):null,
      netBad:window.PnlLoss?window.PnlLoss.netLoss(pn,am):null,
      invAmort:(am&&am.amort!=null)?Math.round(am.amort):null, invEst:!!(am&&am.est),
      surplus:(rewS!=null&&labor!=null)?rewS-labor:null };
  });
  return { overview:{ net, rew, sur:hasLabor?sur:null, rate:rateDen>0?rateNum/rateDen*100:null, salesYoY:hasPrev?(net-netY):null }, stores };
}
let _shareM=null;
async function openShareModal(m){
  let text='';
  try{ const rd=await window.db.collection('monthlyReviews').doc(m).get(); if(rd.exists) text=rd.data().text||''; }catch(e){}
  if(!text){ alert('本月尚無檢討內容，請先撰寫'); return; }
  showLoading();
  const disp={};
  try{ const acc=await window.db.collection('account').get(); acc.forEach(d=>{const a=d.data();if(a.empName&&a.displayName)disp[a.empName]=a.displayName;}); }catch(e){}
  const recs=[];
  for(const s of STORES){
    try{ const es=await window.db.collection('stores').doc(s).collection('employees').get();
      es.forEach(d=>{ const e=d.data()||{}; if(['店長','加盟主'].includes(e.role)&&!['離職','調走'].includes(e.status||'')) recs.push({emp:d.id,store:s,role:e.role,name:disp[d.id]||e.displayName||d.id}); });
    }catch(e){}
  }
  hideLoading();
  const seen=new Set(); const list=recs.filter(r=>{ if(seen.has(r.emp)) return false; seen.add(r.emp); return true; });
  if(!list.length){ alert('查無可傳送的店長／加盟主'); return; }
  _shareM=m;
  const items=list.map(r=>`<label style="display:flex;align-items:center;gap:9px;padding:9px 4px;border-bottom:1px solid #f1f5f9;cursor:pointer;">
    <input type="checkbox" class="shareChk" data-emp="${esc(r.emp)}" checked style="width:18px;height:18px;">
    <span style="flex:1;font-weight:700;">${esc(r.name)} <span style="font-size:11px;color:#64748b;font-weight:600;">${r.role}·${esc(r.store)}</span></span>
  </label>`).join('');
  const ov=document.createElement('div'); ov.id='shareOverlay';
  ov.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9600;display:flex;align-items:center;justify-content:center;padding:14px;';
  ov.innerHTML=`<div style="background:#fff;border-radius:16px;max-width:420px;width:100%;max-height:90vh;overflow:auto;padding:18px;">
    <div style="font-size:16px;font-weight:900;margin-bottom:4px;">🔗 分享 ${m} 營運檢討</div>
    <div style="font-size:12px;color:#64748b;margin-bottom:10px;line-height:1.6;">勾選要收到通知的對象（有開推播發推播，否則 LINE；連結 3 天後自動失效）。</div>
    <label style="display:flex;align-items:center;gap:9px;padding:8px 4px;border-bottom:2px solid #e2e8f0;cursor:pointer;font-weight:800;">
      <input type="checkbox" id="shareAll" checked onchange="document.querySelectorAll('.shareChk').forEach(c=>c.checked=this.checked)" style="width:18px;height:18px;"> 全選
    </label>
    <div style="max-height:44vh;overflow:auto;">${items}</div>
    <div style="display:flex;gap:8px;margin-top:14px;">
      <button onclick="closeShareModal()" style="flex:1;padding:11px;background:#eef1f4;border:none;border-radius:10px;font-weight:700;cursor:pointer;">取消</button>
      <button onclick="doShare()" style="flex:1;padding:11px;background:var(--primary,#e67e22);color:#fff;border:none;border-radius:10px;font-weight:800;cursor:pointer;">發送通知</button>
    </div></div>`;
  ov.onclick=e=>{ if(e.target===ov) closeShareModal(); };
  document.body.appendChild(ov);
}
function closeShareModal(){ const el=document.getElementById('shareOverlay'); if(el) el.remove(); }
function doShare(){
  const emps=[...document.querySelectorAll('.shareChk')].filter(c=>c.checked).map(c=>c.dataset.emp);
  if(!emps.length){ alert('請至少選擇一位對象'); return; }
  closeShareModal();
  shareReview(_shareM, emps);
}
async function shareReview(m, recipients){
  let text='';
  try{ const rd=await window.db.collection('monthlyReviews').doc(m).get(); if(rd.exists) text=rd.data().text||''; }catch(e){}
  if(!text){ alert('本月尚無檢討內容，請先撰寫'); return; }
  const token=(window.crypto&&crypto.randomUUID)?crypto.randomUUID().replace(/-/g,''):(Date.now().toString(36)+Math.random().toString(36).slice(2,12));
  const snap=reviewSnapshot(m);
  const expiresAt=firebase.firestore.Timestamp.fromMillis(Date.now()+3*86400000);
  showLoading();
  try{
    await window.db.collection('sharedReviews').doc(token).set({ ym:m, text, overview:snap.overview, stores:snap.stores,
      createdBy:(currentUser.empName||''), createdByName:(currentUser.displayName||currentUser.empName||''), createdAt:new Date().toISOString(), expiresAt });
    const base=location.href.replace(/[^/]*(\?.*)?(#.*)?$/,''); // 當前頁所在目錄(跟著網域)
    const fn=firebase.app().functions('asia-east1').httpsCallable('shareMonthlyReview');
    const res=await fn({ ym:m, shareToken:token, recipients:(recipients||[]), baseUrl:base });
    const cnt=(res&&res.data&&res.data.count)||0;
    const url=base+'review.html?t='+token;
    try{ await navigator.clipboard.writeText(url); }catch(e){}
    hideLoading();
    alert(`✅ 已通知 ${cnt} 位店長／加盟主（有開推播發推播，否則 LINE）。\n\n連結（3 天有效，已複製到剪貼簿）：\n${url}`);
  }catch(e){ hideLoading(); alert('分享失敗：'+e.message); }
}
// ===== 下鑽入口 =====
function renderLinks(){
  const L=(href,ic,bg,lbl,sub)=>`<div class="link-row" onclick="window.location.href='${href}'"><div class="link-ic" style="background:${bg}">${ic}</div><div class="link-t"><div class="link-lbl">${lbl}</div><div class="link-sub">${sub}</div></div><div class="link-arr">›</div></div>`;
  const R='?ref=owner-dashboard.html'+(OwnerScope.get()?'&store='+encodeURIComponent(OwnerScope.get()):'');
  return `<div class="sec-title">🔎 深入分析</div>`
    + L('performance.html'+R,'📊','#fff3e0','經營績效專區','三店趨勢比較、月度明細、去年同期')
    + `<div class="link-row" onclick="setMainTab('hr')"><div class="link-ic" style="background:#f3e8ff">📈</div><div class="link-t"><div class="link-lbl">人事分析</div><div class="link-sub">成本組成、要注意的人、跨店支援、員工</div></div><div class="link-arr">›</div></div>`
    + L('salary.html?panel=export','📤','#e8f5e9','月結與匯出','薪資管理裡的送審／發布／簽收進度、Excel／PDF');
}
