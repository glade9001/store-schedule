// ② Firestore 規則實測（由 rules-test.sh 在模擬器裡跑，不碰正式資料）：REST＋alg:none JWT；Bearer owner＝Admin 跳過規則
// 2026-10-15 收緊時建立：舊規則這 24 項有 13 項是漏洞。改 firestore.rules 一定要先跑這支，新增規則就在 T 裡加案例。
const H=process.env.FIRESTORE_EMULATOR_HOST,P='demo-rt',B=`http://${H}/v1/projects/${P}/databases/(default)/documents`;
const jwt=uid=>{const b=o=>Buffer.from(JSON.stringify(o)).toString('base64url');return b({alg:'none',typ:'JWT'})+'.'+b({iss:'https://securetoken.google.com/'+P,aud:P,sub:uid,user_id:uid,iat:1,exp:9999999999,auth_time:1,firebase:{sign_in_provider:'password'}})+'.'};
const tv=v=>typeof v==='string'?{stringValue:v}:typeof v==='number'?{integerValue:String(v)}:typeof v==='boolean'?{booleanValue:v}:{mapValue:{fields:Object.fromEntries(Object.entries(v).map(([k,x])=>[k,tv(x)]))}};
const F=o=>({fields:Object.fromEntries(Object.entries(o).map(([k,v])=>[k,tv(v)]))});
const enc=p=>p.split('/').map(encodeURIComponent).join('/');
async function call(method,path,uid,body,mask){const h={'Content-Type':'application/json'};h.Authorization=uid==='ADMIN'?'Bearer owner':'Bearer '+jwt(uid);
 const u=B+'/'+enc(path)+(mask?'?'+mask.map(m=>'updateMask.fieldPaths='+encodeURIComponent(m)).join('&'):'');const r=await fetch(u,{method,headers:h,body:body?JSON.stringify(body):undefined});return r.status;}
const seed=async()=>{for(const [uid,perm,store] of [['emp1','employee','美德'],['mgr1','manager','美德'],['own1','owner','美德']])await call('PATCH',`users/${uid}`,'ADMIN',F({permission:perm,store,empName:uid}));
 await call('PATCH','employees/員工甲/leaveLog/2026-10','ADMIN',F({x:'1'}));await call('PATCH','settings/holidays/years/2026','ADMIN',F({x:'1'}));
 await call('PATCH','settings/globalConfig','ADMIN',F({stores:'美德',clockIn:{geo:{lat:'1'},tolByStore:{美德:5}}}));
 await call('PATCH','salaryAck/emp1_2026-09','ADMIN',F({m:'1'}));await call('PATCH','salaryAck/mgr1_2026-09','ADMIN',F({m:'1'}));await call('PATCH','todos/t1','ADMIN',F({x:'1'}));};
const T=[ // [說明, method, path, uid, body, mask, 預期通過?]
 ['員工讀別人補休帳本','GET','employees/員工甲/leaveLog/2026-10','emp1',null,null,true],
 ['員工改別人補休帳本','PATCH','employees/員工甲/leaveLog/2026-10','emp1',F({x:'2'}),null,false],
 ['員工幫自己新增補休','PATCH','employees/emp1/leaveLog/2026-10','emp1',F({x:'2'}),null,false],
 ['員工刪特休批次','DELETE','employees/員工甲/leaveLog/2026-10','emp1',null,null,false],
 ['員工改員工根文件','PATCH','employees/員工甲','emp1',F({x:'2'}),null,false],
 ['店長改補休帳本','PATCH','employees/員工甲/leaveLog/2026-10','mgr1',F({x:'3'}),null,true],
 ['員工讀國定假日','GET','settings/holidays/years/2026','emp1',null,null,true],
 ['員工改國定假日','PATCH','settings/holidays/years/2026','emp1',F({x:'2'}),null,false],
 ['店長改國定假日','PATCH','settings/holidays/years/2026','mgr1',F({x:'2'}),null,false],
 ['加盟主改國定假日','PATCH','settings/holidays/years/2026','own1',F({x:'2'}),null,true],
 ['店長改本店打卡容許分鐘','PATCH','settings/globalConfig','mgr1',F({clockIn:{geo:{lat:'1'},tolByStore:{美德:8}}}),['clockIn.tolByStore.`美德`'],true],
 ['店長改打卡座標','PATCH','settings/globalConfig','mgr1',F({clockIn:{geo:{lat:'9'}}}),['clockIn.geo'],false],
 ['店長改門市清單','PATCH','settings/globalConfig','mgr1',F({stores:'X'}),['stores'],false],
 ['員工改打卡容許分鐘','PATCH','settings/globalConfig','emp1',F({clockIn:{geo:{lat:'1'},tolByStore:{美德:9}}}),['clockIn.tolByStore.`美德`'],false],
 ['員工簽自己的薪資','PATCH','salaryAck/emp1_2026-10','emp1',F({s:'1'}),null,true],
 ['員工讀自己的簽收','GET','salaryAck/emp1_2026-09','emp1',null,null,true],
 ['員工讀別人的簽收','GET','salaryAck/mgr1_2026-09','emp1',null,null,false],
 ['員工幫別人簽收','PATCH','salaryAck/mgr1_2026-10','emp1',F({s:'1'}),null,false],
 ['員工 id 前綴騙（emp1x_）','PATCH','salaryAck/emp1x_2026-10','emp1',F({s:'1'}),null,false],
 ['店長讀別人簽收','GET','salaryAck/emp1_2026-09','mgr1',null,null,true],
 ['員工讀別人簽名','GET','salaryAckSig/mgr1_2026-09','emp1',null,null,false],
 ['員工刪自己的簽收','DELETE','salaryAck/emp1_2026-09','emp1',null,null,false],
 ['catch-all 其他照舊：員工寫待辦勾選','PATCH','todos/t1','emp1',F({x:'2'}),null,true],
 ['未登入讀帳本','GET','employees/員工甲/leaveLog/2026-10',null,null,null,false],
];
(async()=>{await seed();let fail=0;
 for(const [d,m,p,u,b,mask,exp] of T){let st;if(u===null){const r=await fetch(B+'/'+enc(p));st=r.status}else st=await call(m,p,u,b,mask);const ok=st<300;const pass=ok===exp;if(!pass)fail++;console.log(pass?'✅':'❌',d,'→',ok?'允許':'拒絕',`(${st})`);}
 console.log(fail?`${fail} 項不符`:'全部符合');process.exit(fail?1:0);})();
