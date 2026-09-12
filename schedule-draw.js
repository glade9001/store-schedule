/**
 * 職員輪班表產圖 —— 全專案唯一版本
 *
 * ⚠️ 2026-09-12 從 schedule-v2-page.js 抽出來的，原封不動。
 *    盤點資料（inspection.html）要印出「跟排班系統一模一樣」的輪班表，
 *    複製一份就等於保證兩邊遲早長不一樣（國定假日表才剛因為五份拷貝出過事）。
 *
 * 依賴：呼叫端若有全域 scheduleDrawName() 就會用它把本名換成顯示名；
 *       沒有的話（例如盤點頁的姓名是直接手輸的）就原樣輸出。
 *
 * 本檔刻意「只有 function 宣告、沒有任何頂層 const」——與 shift-utils.js 同規矩，
 * 任何頁面掛上來都不會撞名把整段 script 打掛。
 */

/** 顯示名解析：有全域 getDisplayName 就用，否則原樣回傳 */
function scheduleDrawName(empName) {
  // ⚠️ 一定要透過 window 取，不能寫成 getDisplayName(...)：
  //    本檔內所有 getDisplayName( 呼叫都已改名為 scheduleDrawName(，
  //    這裡若也寫成同名就會變成自己呼叫自己（無窮遞迴）。
  var f = (typeof window !== 'undefined') ? window.getDisplayName : null;
  return (typeof f === 'function') ? f(empName) : empName;
}

function calcCanvasLines(ctx, text, maxWidth) {
  if (!text) return 1;
  let line = '', lines = 1;
  for (const ch of text) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) { lines++; line = ch; }
    else line = test;
  }
  return lines;
}

function canvasDrawWrappedText(ctx, text, cx, startY, maxWidth, lineHeight) {
  let y = startY;
  for (const segment of text.split('\n')) {
    let line = '';
    for (const ch of segment) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxWidth && line) {
        ctx.fillText(line, cx, y); line = ch; y += lineHeight;
      } else { line = test; }
    }
    if (line) { ctx.fillText(line, cx, y); y += lineHeight; }
  }
}

function drawScheduleCanvas(canvas, store, weekStr, records, emps, weekDates, allStoresRecs) {
  // allStoresRecs: 全部門市的記錄，用來查跨店支援
  const allRecs = allStoresRecs || records;
  const ctx = canvas.getContext('2d');
  const font = '"Microsoft JhengHei", "PingFang TC", sans-serif';
  const W = 1500;
  const margin = 50; // 兩側留白
  const tableW = W - margin * 2;
  const nameColW = 160;
  const dataColW = (tableW - nameColW) / 7;
  const rowH = 116;
  const headerH = 100;
  const titleH = 200;
  const emptyRows = 5;
  const noteLineH = 28;
  const noteMaxW = dataColW - 16;
  // 動態計算備註列高度
  const _tmpCtx = document.createElement('canvas').getContext('2d');
  _tmpCtx.font = `bold 20px ${font}`;
  const _notedays = ['週一','週二','週三','週四','週五','週六','週日'];
  let _maxNoteLines = 1;
  _notedays.forEach(day => {
    const r = (allStoresRecs || records).find(r => r.name === '門市備註' && r.day === day);
    if (r?.note) _maxNoteLines = Math.max(_maxNoteLines, calcCanvasLines(_tmpCtx, r.note, noteMaxW));
  });
  const noteRowH = Math.max(rowH, _maxNoteLines * noteLineH + 24);
  const numDataRows = emps.length; // 備註列單獨計算
  const H = titleH + headerH + numDataRows * rowH + noteRowH + emptyRows * rowH + 80;

  canvas.width = W;
  canvas.height = H;

  // 白底
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);

  // ===== 標題 =====
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#000';
  ctx.font = `900 54px ${font}`;
  ctx.fillText(`${store} 職員輪班表`, W / 2, 70);

  ctx.font = `bold 26px ${font}`;
  ctx.fillStyle = '#333';
  const d0 = weekDates[0].split('/'), d6 = weekDates[6].split('/');
  ctx.fillText(`${d0[0]} 月 ${d0[1]} 日  至  ${d6[0]} 月 ${d6[1]} 日`, W / 2, 140);

  // ===== 表格外框 =====
  const tableTop = titleH;
  const tableH = headerH + numDataRows * rowH + noteRowH + emptyRows * rowH;
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 3;
  ctx.strokeRect(margin, tableTop, tableW, tableH);

  // 欄線
  ctx.lineWidth = 2;
  let x = margin + nameColW;
  ctx.beginPath(); ctx.moveTo(x, tableTop); ctx.lineTo(x, tableTop + tableH); ctx.stroke();
  for (let i = 1; i < 7; i++) {
    x = margin + nameColW + i * dataColW;
    ctx.beginPath(); ctx.moveTo(x, tableTop); ctx.lineTo(x, tableTop + tableH); ctx.stroke();
  }

  // 列線（員工列）
  for (let i = 0; i <= numDataRows; i++) {
    const ly = tableTop + headerH + i * rowH;
    ctx.beginPath(); ctx.moveTo(margin, ly); ctx.lineTo(margin + tableW, ly); ctx.stroke();
  }
  // 備註列底線
  const _noteRowBottom = tableTop + headerH + numDataRows * rowH + noteRowH;
  ctx.beginPath(); ctx.moveTo(margin, _noteRowBottom); ctx.lineTo(margin + tableW, _noteRowBottom); ctx.stroke();
  // 空白列
  for (let i = 1; i <= emptyRows; i++) {
    const ly = _noteRowBottom + i * rowH;
    ctx.beginPath(); ctx.moveTo(margin, ly); ctx.lineTo(margin + tableW, ly); ctx.stroke();
  }

  // ===== 表頭 =====
  // 左上角斜線格（月/日 ╲ 姓名）
  ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(margin, tableTop);
  ctx.lineTo(margin + nameColW, tableTop + headerH);
  ctx.stroke();

  ctx.fillStyle = '#000';
  ctx.font = `bold 20px ${font}`;
  ctx.textAlign = 'right';
  ctx.fillText('月/日', margin + nameColW - 10, tableTop + 28);
  ctx.textAlign = 'left';
  ctx.fillText('姓名', margin + 10, tableTop + headerH - 22);

  // 日期表頭
  ctx.textAlign = 'center';
  const dayNames = ['週一','週二','週三','週四','週五','週六','週日'];

// 台灣國定假日 2026-2027


  for (let i = 0; i < 7; i++) {
    // ✅ 修正：加上 margin，與員工列 cx 計算一致
    const cx = margin + nameColW + i * dataColW + dataColW / 2;
    const cy = tableTop + headerH / 2;
    ctx.fillStyle = '#000';
    ctx.font = `900 24px ${font}`;
    ctx.fillText(weekDates[i], cx, cy - 14);
    ctx.font = `normal 20px ${font}`;
    ctx.fillText(dayNames[i], cx, cy + 18);
  }

  // ===== 員工列 =====
  let rowY = tableTop + headerH;
  emps.forEach(emp => {
    const midY = rowY + rowH / 2;
    // 姓名（支援人員加底色標記）
    if(emp._isSupport) {
      // 支援人員：淡藍底色 + 姓名 + 「支援」小字
      ctx.fillStyle = '#e8f0fe';
      ctx.fillRect(margin, rowY, nameColW, rowH);
      ctx.fillStyle = '#1a73e8';
      ctx.font = `900 26px ${font}`;
      ctx.textAlign = 'center';
      ctx.fillText(scheduleDrawName(emp.name), margin + nameColW / 2, midY - 10);
      ctx.font = `bold 16px ${font}`;
      ctx.fillText(`支援自${emp._fromStore}`, margin + nameColW / 2, midY + 16);
    } else {
      ctx.fillStyle = '#000';
      ctx.font = `900 28px ${font}`;
      ctx.textAlign = 'center';
      if (!emp.name.startsWith('🆘')) {
        ctx.fillText(scheduleDrawName(emp.name), margin + nameColW / 2, midY);
      }
    }

    dayNames.forEach((day, i) => {
      const cx = margin + nameColW + i * dataColW + dataColW / 2;
      let rec = records.find(r => r.name === emp.name && r.day === day) || {};
      const shift = rec.shift || '';
      const note = rec.note || '';
      const loc = (rec.location && rec.location !== '本店') ? rec.location : '';
      const supportEmp = rec.supportEmp || '';
      const supportName = supportEmp ? scheduleDrawName(supportEmp.split('-')[1] || supportEmp) : '';
      const isApproved = (rec.approvalStatus || '') === 'approved';
      const h = parseFloat(rec.actualHours || 0);
      const recIsSupportOut = !!(loc && loc.startsWith('支援'));

      // 跨店支援：本店員工當天去他店支援（新模型下支援者本店多為休假，故不要求本店有班也要顯示）
      let supportOut = null;
      if(!emp.name.startsWith('🆘') && !recIsSupportOut) {
        supportOut = allRecs.find(r =>
          r.supportEmp === `${store}-${emp.name}` && r.day === day && r.week === weekStr && r.approvalStatus === 'approved'
        );
      }

      // 跨店支援顯示，比照螢幕版區分兩種情境：
      //  (a) 整日外派(本店休/無班) → 用對方店班別當主文字(黑,大) + 紅「支援X」(舊 loc 格式)、備註取對方店
      //  (b) 本店有主班 + 同日又去他店支援 → 主班保留當主文字 + 藍「支援X 班別」徽章(勿用支援班覆蓋本店主班)
      const homeHasShift = !!(shift && shift !== '排休' && shift !== '指休' && !recIsSupportOut);
      const isFullDaySupport = !!supportOut && !homeHasShift && !recIsSupportOut;
      const alsoSupport = !!supportOut && homeHasShift;
      const effShift = isFullDaySupport ? (supportOut.shift || '') : shift;
      const effIsOT  = isFullDaySupport ? (supportOut.isOT === true) : (rec.isOT === true);
      const effH     = isFullDaySupport ? parseFloat(supportOut.actualHours || 0) : h;
      const effNote  = isFullDaySupport ? (supportOut.note || '') : note;

      // 附加資訊（由上到下堆疊）；產圖不顯示時數
      const subs = [];
      if (supportName && isApproved) subs.push({ t: supportName, c:'#1a73e8', s:20 });
      if (loc) subs.push({ t: loc, c:'#c0392b', s:18 });
      if (isFullDaySupport) subs.push({ t:`支援${supportOut._store}`, c:'#c0392b', s:18 });
      if (alsoSupport) subs.push({ t:`支援${supportOut._store} ${supportOut.shift || ''}`.trim(), c:'#0369a1', s:16 });
      if (effNote) subs.push({ t: effNote, c:'#0077aa', s:16 });

      // 班別主文字 Y：有附加行時整體往上挪
      const shiftY = subs.length ? midY - 6 - (subs.length - 1) * 6 : midY;

      if (effShift === '指休') {
        ctx.strokeStyle = '#d93025'; ctx.lineWidth = 2.5;
        const bw = 52, bh = 44;
        ctx.strokeRect(cx - bw/2, shiftY - bh/2 - 4, bw, bh);
        ctx.fillStyle = '#d93025';
        ctx.font = `900 30px ${font}`;
        ctx.fillText('休', cx, shiftY);
      } else if (effShift === '排休') {
        ctx.fillStyle = '#000';
        ctx.font = `900 30px ${font}`;
        ctx.fillText('休', cx, shiftY);
      } else if (effShift) {
        const isOT = effIsOT;
        const multi = effShift.includes(',');       // 兩頭班：不做開始/結束拆色
        const overHours = effH > 8;
        ctx.font = `900 26px ${font}`;
        if (isOT) {
          ctx.fillStyle = '#d93025';
          ctx.fillText(effShift, cx, shiftY);
        } else if (overHours && !multi && effShift.includes('-')) {
          // 超過8小時：結束時間數字標紅（保留 - 分隔）
          const parts = effShift.split('-');
          const startTxt = parts[0] + '-', endTxt = parts[1];
          const startW = ctx.measureText(startTxt).width;
          const totalW = startW + ctx.measureText(endTxt).width;
          ctx.textAlign = 'left';
          ctx.fillStyle = '#000';
          ctx.fillText(startTxt, cx - totalW/2, shiftY);
          ctx.fillStyle = '#d93025';
          ctx.fillText(endTxt, cx - totalW/2 + startW, shiftY);
          ctx.textAlign = 'center';
        } else {
          ctx.fillStyle = '#000';
          ctx.fillText(effShift, cx, shiftY);
        }
      }

      // 附加行（堆疊）
      let subY = shiftY + 22;
      subs.forEach(sub => {
        ctx.fillStyle = sub.c;
        ctx.font = `bold ${sub.s}px ${font}`;
        ctx.fillText(sub.t, cx, subY);
        subY += sub.s + 6;
      });
    });
    rowY += rowH;
  });

  // ===== 備註列 =====
  ctx.fillStyle = '#000';
  ctx.font = `900 24px ${font}`;
  ctx.textAlign = 'center';
  ctx.fillText('門市備註', margin + nameColW / 2, rowY + noteRowH / 2 + 8);
  dayNames.forEach((day, i) => {
    const rec = records.find(r => r.name === '門市備註' && r.day === day);
    if (rec?.note) {
      ctx.fillStyle = '#0077aa';
      ctx.font = `bold 20px ${font}`;
      const cx = margin + nameColW + i * dataColW + dataColW / 2;
      const totalLines = calcCanvasLines(ctx, rec.note, noteMaxW);
      const startY = rowY + (noteRowH - totalLines * noteLineH) / 2 + noteLineH * 0.8;
      canvasDrawWrappedText(ctx, rec.note, cx, startY, noteMaxW, noteLineH);
    }
  });

  // ===== 備注文字 =====
  ctx.textAlign = 'left';
  ctx.fillStyle = '#333';
  ctx.font = `bold 19px ${font}`;
  ctx.fillText('※每周五、六公佈下週排班表，若有變動者，請事先向店長反映，勿私自調動！', margin, H - 22);
}
