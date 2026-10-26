'use strict';
// 筋トレメモ: 記録はこの端末（localStorage）に保存。スプレッドシートへは Apps Script 経由で書き込む

const KEY = 'kintore.v1';
const PRESETS = ['ベンチプレス', 'スクワット', 'デッドリフト', 'インクラインベンチプレス', 'ダンベルプレス', 'ショルダープレス',
  'ラットプルダウン', '懸垂', 'ベントオーバーロウ', 'レッグプレス', 'アームカール', 'トライセプスエクステンション', 'ディップス'];
const DEFAULT_SETTINGS = { url: '', key: '', sheet: '日次記録', dateCol: 'A', col: 'F', sep: '／', autoSync: false, timer: 60 };

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- データ ----------
let db = load();
function load() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(KEY)); } catch {}
  if (!d || typeof d !== 'object') d = {};
  return {
    days: d.days && typeof d.days === 'object' ? d.days : {},
    exercises: Array.isArray(d.exercises) ? d.exercises : PRESETS.slice(),
    settings: Object.assign({}, DEFAULT_SETTINGS, d.settings),
  };
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { toast('保存できませんでした: ' + e.message); }
}
function getDay(date, create) {
  if (!db.days[date] && create) db.days[date] = { exercises: [] };
  return db.days[date];
}
// 記録が空になった日は消す（カレンダーに印が残らないように）
function cleanDay(date) {
  const d = db.days[date];
  if (!d) return;
  d.exercises = d.exercises.filter((e) => e.sets.length);
  if (!d.exercises.length && !d.synced) delete db.days[date];
}

// ---------- 日付 ----------
const pad = (n) => String(n).padStart(2, '0');
const ymd = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
const today = () => ymd(new Date());
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const slash = (s) => s.replace(/-/g, '/');
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
const DOW = ['日', '月', '火', '水', '木', '金', '土'];
const label = (s) => `${slash(s)}（${DOW[parse(s).getDay()]}）`;

// ---------- 計算 ----------
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
// 1RM の目安（アプリと同じ式: 重さ ×（1 + 回数/40））
const rm = (w, r) => (w > 0 && r > 0 ? w * (1 + r / 40) : 0);
const fmtW = (w) => String(Math.round(w * 100) / 100);
const vol = (sets) => sets.reduce((a, s) => a + num(s.w) * num(s.r), 0);
const dayVol = (d) => (d ? d.exercises.reduce((a, e) => a + vol(e.sets), 0) : 0);
const tons = (kg) => (kg / 1000).toFixed(2) + ' t';

function lastRecord(name, before) {
  const dates = Object.keys(db.days).filter((d) => d < before).sort().reverse();
  for (const d of dates) {
    const e = db.days[d].exercises.find((x) => x.name === name && x.sets.length);
    if (e) return { date: d, sets: e.sets };
  }
  return null;
}
function bestRM(name, exceptDate) {
  let best = 0;
  for (const [d, day] of Object.entries(db.days)) {
    if (d === exceptDate) continue;
    for (const e of day.exercises) if (e.name === name) for (const s of e.sets) best = Math.max(best, rm(num(s.w), num(s.r)));
  }
  return best;
}

// スプレッドシートに書く文字: ベンチプレス（20kg×10、40kg×5）
function sheetText(day) {
  if (!day) return '';
  return day.exercises.filter((e) => e.sets.length)
    .map((e) => `${e.name}（${e.sets.map((s) => `${fmtW(num(s.w))}kg×${num(s.r)}${s.memo ? `[${s.memo}]` : ''}`).join('、')}）`)
    .join(db.settings.sep);
}
function syncState(date) {
  const day = db.days[date];
  const text = sheetText(day);
  if (!day || !text) return { text, state: 'empty' };
  if (!day.synced) return { text, state: 'new' };
  return { text, state: day.synced.text === text ? 'done' : 'changed' };
}

// ---------- スプレッドシート ----------
async function callGas(body) {
  const s = db.settings;
  if (!s.url) throw new Error('設定画面で Apps Script の URL を入れてください');
  const res = await fetch(s.url, {
    method: 'POST',
    // text/plain にすると事前確認（CORS のプリフライト）が起きず Apps Script で受け取れる
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(Object.assign({ key: s.key, sheet: s.sheet, dateCol: s.dateCol, col: s.col }, body)),
  });
  let j;
  try { j = await res.json(); } catch { throw new Error('返事が読めませんでした（URL・公開設定を確認してください）'); }
  if (!j.ok) throw new Error(j.error || '書き込みに失敗しました');
  return j;
}
async function sendDay(date, text) {
  const day = getDay(date, true);
  const j = await callGas({ action: 'write', date: slash(date), text });
  day.synced = { text: sheetText(day), sent: text, at: Date.now() };
  save();
  return j;
}
function resultMsg(date, j) {
  if (j.mode === 'inserted') return `${slash(date)} の行を追加して書き込みました（${j.row}行目）`;
  return `${slash(date)} の行を上書きしました（${j.row}行目）` + (j.prev ? `\n前の内容: ${j.prev.slice(0, 40)}${j.prev.length > 40 ? '…' : ''}` : '');
}
let autoTimer = 0;
function scheduleAutoSync(date) {
  if (!db.settings.autoSync || !db.settings.url) return;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(async () => {
    const st = syncState(date);
    if (st.state !== 'new' && st.state !== 'changed') return;
    try { await sendDay(date, st.text); toast('スプレッドシートに自動で書き込みました'); } catch (e) { toast('自動書き込み失敗: ' + e.message); }
  }, 4000);
}

// ---------- 画面の切り替え ----------
window.addEventListener('hashchange', render);
$('#backBtn').onclick = () => { location.hash = $('#backBtn').dataset.to || '#/'; };
function header(title, back) {
  $('#title').textContent = title;
  const b = $('#backBtn');
  b.hidden = !back;
  b.dataset.to = back || '';
}
function setTab(t) {
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === t));
}
let calMonth = null;
let onLeave = null; // 画面を離れるときの片づけ
function render() {
  stopTimer();
  if (onLeave) { const f = onLeave; onLeave = null; f(); }
  const p = location.hash.replace(/^#\/?/, '').split('/');
  const main = $('#main');
  main.innerHTML = '';
  window.scrollTo(0, 0);
  if (p[0] === 'day' && /^\d{4}-\d\d-\d\d$/.test(p[1])) {
    setTab('home');
    if (p[2] === 'ex' && p[3] != null) return viewExercise(main, p[1], Number(p[3]));
    if (p[2] === 'pick') return viewPick(main, p[1]);
    return viewDay(main, p[1]);
  }
  if (p[0] === 'history') { setTab('history'); return viewHistory(main, p[1] ? decodeURIComponent(p[1]) : ''); }
  if (p[0] === 'settings') { setTab('settings'); return viewSettings(main); }
  setTab('home');
  viewHome(main);
}

// ---------- ホーム ----------
function viewHome(main) {
  header('筋トレメモ');
  if (!calMonth) { const t = new Date(); calMonth = new Date(t.getFullYear(), t.getMonth(), 1); }
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  const start = new Date(y, m, 1 - new Date(y, m, 1).getDay());
  const td = today();
  const has = (d) => db.days[d] && db.days[d].exercises.some((e) => e.sets.length);
  let cells = DOW.map((w) => `<div class="dow">${w}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const d = ymd(dt);
    const cls = ['d', dt.getMonth() !== m && 'out', has(d) && 'done', d === td && 'today'].filter(Boolean).join(' ');
    cells += `<button class="${cls}" data-d="${d}">${dt.getDate()}</button>`;
  }
  const monthKey = `${y}-${pad(m + 1)}`;
  const trained = Object.keys(db.days).filter(has);
  const monthDays = trained.filter((d) => d.startsWith(monthKey)).length;
  const sumRange = (from, to) => trained.filter((d) => d >= from && d <= to).reduce((a, d) => a + dayVol(db.days[d]), 0);
  const v7 = sumRange(addDays(td, -6), td), v28 = sumRange(addDays(td, -27), td);
  const total = trained.reduce((a, d) => a + dayVol(db.days[d]), 0);
  // 週ごと（日曜はじまり）の負荷量
  const weekStart = addDays(td, -parse(td).getDay());
  const weeks = [0, 1, 2, 3, 4, 5].map((k) => sumRange(addDays(weekStart, -7 * k), addDays(weekStart, -7 * k + 6)));
  const wmax = Math.max(...weeks, 1);

  main.innerHTML = `
  <section class="hero">
    <div class="cal-head"><button data-mv="-1">‹</button><h2>${y}年 ${m + 1}月</h2><button data-mv="1">›</button></div>
    <div class="cal">${cells}</div>
    <div class="stats">
      <div class="stat"><small>今月 / 合計</small><b>${monthDays}</b> 日 / ${trained.length} 日</div>
      <div class="stat"><small>総合計負荷量</small><b>${tons(total)}</b></div>
      <div class="stat"><small>負荷量 / 7日間</small><b>${tons(v7)}</b></div>
      <div class="stat"><small>負荷量 / 28日間</small><b>${tons(v28)}</b></div>
    </div>
    <div class="bars">${weeks.map((w, k) => `<div><span>${k ? k + '週前' : '今週'}</span><i style="width:${(w / wmax) * 70}%"></i></div>`).join('')}</div>
  </section>
  <div class="row2">
    <button class="btn" id="addToday">＋ 今日のトレーニング</button>
    <button class="btn outline" id="rmBtn">RM計算</button>
  </div>
  ${unsyncedBox()}`;
  main.querySelectorAll('[data-mv]').forEach((b) => (b.onclick = () => { calMonth = new Date(y, m + Number(b.dataset.mv), 1); render(); }));
  main.querySelectorAll('.cal .d').forEach((b) => (b.onclick = () => { location.hash = `#/day/${b.dataset.d}`; }));
  $('#addToday').onclick = () => { location.hash = `#/day/${td}`; };
  $('#rmBtn').onclick = openRM;
  bindUnsynced(main);
}
function unsyncedDates() {
  return Object.keys(db.days).filter((d) => ['new', 'changed'].includes(syncState(d).state)).sort();
}
function unsyncedBox() {
  if (!db.settings.url) {
    return `<div class="sheet"><h4>スプレッドシート連携</h4><p class="note">設定画面で Apps Script の URL を入れると、記録をスプレッドシートに書き込めます。</p>
      <button class="btn small outline" onclick="location.hash='#/settings'">設定を開く</button></div>`;
  }
  const u = unsyncedDates();
  if (!u.length) return '';
  return `<div class="sheet"><h4>未送信の記録が ${u.length} 日分あります</h4>
    <p class="st">${u.map(slash).join('、')}</p><button class="btn small" id="sendAll">まとめて書き込む</button></div>`;
}
function bindUnsynced(main) {
  const b = $('#sendAll', main);
  if (!b) return;
  b.onclick = async () => {
    b.disabled = true;
    let ok = 0;
    for (const d of unsyncedDates()) {
      b.textContent = `書き込み中… ${slash(d)}`;
      try { await sendDay(d, syncState(d).text); ok++; } catch (e) { toast(`${slash(d)}: ${e.message}`); break; }
    }
    if (ok) toast(`${ok} 日分を書き込みました`);
    render();
  };
}

// ---------- 1日の記録 ----------
function viewDay(main, date) {
  header(label(date), '#/');
  const day = getDay(date);
  const ex = day ? day.exercises : [];
  const sets = ex.reduce((a, e) => a + e.sets.length, 0);
  const reps = ex.reduce((a, e) => a + e.sets.reduce((b, s) => b + num(s.r), 0), 0);
  const st = syncState(date);
  const stText = { empty: '', new: '未送信', changed: '送信後に記録が変わっています', done: '送信済み' }[st.state];
  const at = day && day.synced ? new Date(day.synced.at) : null;
  main.innerHTML = `
  <div class="toolbar">
    <button class="btn small gray" data-go="-1">‹ 前日</button>
    <button class="btn small gray" data-go="1">翌日 ›</button>
  </div>
  <div class="sum">
    <div><small>種目数</small><b>${ex.length}</b></div>
    <div><small>セット数</small><b>${sets}</b></div>
    <div><small>レップ数</small><b>${reps}</b></div>
    <div><small>負荷量</small><b>${Math.round(dayVol(day))}</b></div>
  </div>
  ${ex.length ? ex.map((e, i) => `
  <div class="card tap" data-i="${i}">
    <h3><span class="grow">${esc(e.name)}</span>
      <button data-up="${i}" aria-label="上へ">▲</button><button data-down="${i}" aria-label="下へ">▼</button></h3>
    <div class="body">${e.sets.length ? `<table class="setlist">${e.sets.map((s, k) => `<tr><td class="n">${k + 1}</td>
      <td><b>${fmtW(num(s.w))}</b> kg × <b>${num(s.r)}</b> 回${s.memo ? ` <small>${esc(s.memo)}</small>` : ''}</td>
      <td class="rm">RM ${fmtW(rm(num(s.w), num(s.r)))}</td></tr>`).join('')}</table>` : '<div class="empty">セットなし（タップして入力）</div>'}</div>
  </div>`).join('') : '<div class="empty">まだ記録がありません。<br>右下の ＋ から種目を追加してね</div>'}
  ${st.text ? `
  <div class="sheet">
    <h4>スプレッドシートに書き込む内容</h4>
    <textarea id="sheetText">${esc(day.synced && day.synced.text === st.text && day.synced.sent ? day.synced.sent : st.text)}</textarea>
    <div class="st ${st.state === 'done' ? '' : 'warn'}">${stText}${at ? `（最終送信 ${at.getMonth() + 1}/${at.getDate()} ${pad(at.getHours())}:${pad(at.getMinutes())}）` : ''}</div>
    <p class="note">「${esc(db.settings.sheet)}」シートの ${esc(db.settings.dateCol)}列 で ${slash(date)} を探して ${esc(db.settings.col)}列 を上書きします。日付がなければ行を追加します。</p>
    <button class="btn" id="send">スプレッドシートに書き込む</button>
  </div>` : ''}
  <button class="fab" id="fab" aria-label="種目を追加">＋</button>`;
  main.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => { location.hash = `#/day/${addDays(date, Number(b.dataset.go))}`; }));
  main.querySelectorAll('.card.tap').forEach((c) => (c.onclick = (ev) => {
    const up = ev.target.dataset.up, down = ev.target.dataset.down;
    if (up != null || down != null) {
      ev.stopPropagation();
      const i = Number(up ?? down), j = up != null ? i - 1 : i + 1;
      if (j < 0 || j >= ex.length) return;
      [ex[i], ex[j]] = [ex[j], ex[i]];
      save(); render(); return;
    }
    location.hash = `#/day/${date}/ex/${c.dataset.i}`;
  }));
  $('#fab').onclick = () => { location.hash = `#/day/${date}/pick`; };
  const send = $('#send');
  if (send) send.onclick = async () => {
    const text = $('#sheetText').value.trim();
    if (!text) return toast('書き込む内容が空です');
    send.disabled = true; send.textContent = '書き込み中…';
    try { const j = await sendDay(date, text); toast(resultMsg(date, j), 4000); render(); } catch (e) {
      toast(e.message, 4000); send.disabled = false; send.textContent = 'スプレッドシートに書き込む';
    }
  };
}

// ---------- 種目を選ぶ ----------
function viewPick(main, date) {
  header('種目を選ぶ', `#/day/${date}`);
  const lastDate = (name) => { const r = lastRecord(name, '9999'); return r ? slash(r.date) : ''; };
  main.innerHTML = `
  <div class="add-line"><input id="newName" placeholder="種目を追加（例: ヒップスラスト）"><button class="btn small" id="addName">追加</button></div>
  <div class="list">${db.exercises.map((n, i) => `<div class="it" data-n="${i}"><span class="grow">${esc(n)}</span><small>${lastDate(n)}</small>
    <button class="x" data-x="${i}" aria-label="一覧から消す">✕</button></div>`).join('')}</div>`;
  const pick = (name) => {
    const day = getDay(date, true);
    let i = day.exercises.findIndex((e) => e.name === name);
    if (i < 0) { day.exercises.push({ name, sets: [] }); i = day.exercises.length - 1; save(); }
    location.hash = `#/day/${date}/ex/${i}`;
  };
  main.querySelectorAll('.it').forEach((el) => (el.onclick = (ev) => {
    const x = ev.target.dataset.x;
    if (x != null) {
      ev.stopPropagation();
      if (!confirm(`「${db.exercises[x]}」を一覧から消しますか？（記録は消えません）`)) return;
      db.exercises.splice(Number(x), 1); save(); render(); return;
    }
    pick(db.exercises[el.dataset.n]);
  }));
  $('#addName').onclick = () => {
    const n = $('#newName').value.trim();
    if (!n) return;
    if (!db.exercises.includes(n)) { db.exercises.unshift(n); save(); }
    pick(n);
  };
}

// ---------- 種目の入力 ----------
function viewExercise(main, date, idx) {
  const day = getDay(date);
  const ex = day && day.exercises[idx];
  if (!ex) { location.hash = `#/day/${date}`; return; }
  header(ex.name, `#/day/${date}`);
  const last = lastRecord(ex.name, date);
  const best = bestRM(ex.name, date);
  if (!ex.sets.length && !last) ex.sets.push({ w: '', r: '', memo: '' });

  main.innerHTML = `
  <div class="toolbar">
    ${best ? `<span class="pr">🏆 自己ベスト RM ${fmtW(best)} kg</span>` : ''}
    <div class="timer"><span>⏱</span><input id="tsec" inputmode="numeric" value="${db.settings.timer}"><button id="tbtn">START</button></div>
  </div>
  ${last ? `<div class="last"><b>前回: ${slash(last.date)}</b>
    <button class="btn small gray copy" id="copyLast">前回をコピー</button>
    <ol>${last.sets.map((s) => `<li>${fmtW(num(s.w))} kg × ${num(s.r)} 回${s.memo ? ` (${esc(s.memo)})` : ''}</li>`).join('')}</ol></div>` : ''}
  <div id="sets"></div>
  <div class="btns">
    <button class="btn outline" id="addSet">＋ セットを追加</button>
    <button class="btn gray small" id="delEx">この種目を消す</button>
  </div>
  <div style="height:20px"></div>`;

  const box = $('#sets');
  const drawSets = () => {
    box.innerHTML = ex.sets.map((s, k) => `
    <div class="set" data-k="${k}">
      <div class="line"><span class="no">${k + 1}</span>
        <span class="stepper"><button class="step" data-step="1" aria-label="2.5kg 増やす">▲</button><button class="step" data-step="-1" aria-label="2.5kg 減らす">▼</button></span>
        <input class="num w" data-f="w" inputmode="decimal" value="${esc(s.w)}" placeholder="0"><span class="unit">kg ×</span>
        <input class="num" data-f="r" inputmode="numeric" value="${esc(s.r)}" placeholder="0" style="width:3em"><span class="unit">回</span>
        <span class="rm"></span><button class="del" data-del="${k}" aria-label="セットを消す">✕</button></div>
      <input class="memo" data-f="memo" value="${esc(s.memo || '')}" placeholder="メモ（補助ありなど）">
    </div>`).join('');
    ex.sets.forEach((_, k) => updRM(k));
  };
  const updRM = (k) => {
    const s = ex.sets[k];
    const el = box.querySelector(`.set[data-k="${k}"] .rm`);
    const v = rm(num(s.w), num(s.r));
    el.textContent = v ? `RM ${fmtW(v)}` : '';
    el.classList.toggle('best', v > 0 && v > best);
    if (v > 0 && v > best && best > 0) el.textContent += ' 🏆';
  };
  box.addEventListener('input', (ev) => {
    const f = ev.target.dataset.f;
    if (!f) return;
    const k = Number(ev.target.closest('.set').dataset.k);
    ex.sets[k][f] = ev.target.value.trim();
    save();
    if (f !== 'memo') updRM(k);
    scheduleAutoSync(date);
  });
  // おもりを 2.5kg 刻みで動かす（▲▼ボタン、または数字を上下にスライド）。数字はタップすれば自由に書ける
  const STEP = 2.5;
  const stepW = (k, dir) => {
    const s = ex.sets[k];
    const input = box.querySelector(`.set[data-k="${k}"] input.w`);
    let v;
    if (s.w === '' || !Number.isFinite(parseFloat(s.w))) {
      // 空なら前のセットの重さ（なければ 20kg）から始める
      const prev = ex.sets.slice(0, k).reverse().find((x) => num(x.w));
      v = prev ? num(prev.w) : 20;
    } else {
      const w = num(s.w);
      // 2.5 の倍数にそろえながら動かす（61 → ▲ 62.5 / ▼ 60）
      v = dir > 0 ? (Math.floor(w / STEP + 1e-6) + 1) * STEP : (Math.ceil(w / STEP - 1e-6) - 1) * STEP;
    }
    v = Math.max(0, Math.round(v * 100) / 100);
    s.w = fmtW(v);
    input.value = s.w;
    save(); updRM(k); scheduleAutoSync(date);
    try { navigator.vibrate && navigator.vibrate(8); } catch {}
  };
  let drag = null;
  box.addEventListener('pointerdown', (ev) => {
    if (!ev.target.matches('input.w')) return;
    drag = { el: ev.target, k: Number(ev.target.closest('.set').dataset.k), y: ev.clientY, moved: false, id: ev.pointerId };
  });
  box.addEventListener('pointermove', (ev) => {
    if (!drag || ev.pointerId !== drag.id) return;
    const dy = drag.y - ev.clientY;
    if (!drag.moved && Math.abs(dy) < 10) return;
    if (!drag.moved) { drag.moved = true; drag.el.blur(); drag.el.classList.add('dragging'); try { drag.el.setPointerCapture(ev.pointerId); } catch {} }
    ev.preventDefault();
    // 22px 動かすごとに 1段階
    const steps = Math.trunc(dy / 22);
    if (steps) { for (let i = 0; i < Math.abs(steps); i++) stepW(drag.k, Math.sign(steps)); drag.y -= steps * 22; }
  });
  const endDrag = (ev) => {
    if (!drag) return;
    if (drag.moved) { ev.preventDefault(); drag.el.classList.remove('dragging'); drag.el.blur(); }
    drag = null;
  };
  box.addEventListener('pointerup', endDrag);
  box.addEventListener('pointercancel', endDrag);
  box.addEventListener('click', (ev) => {
    const st = ev.target.dataset.step;
    if (st != null) { stepW(Number(ev.target.closest('.set').dataset.k), Number(st)); return; }
    const d = ev.target.dataset.del;
    if (d == null) return;
    ex.sets.splice(Number(d), 1);
    save(); drawSets(); scheduleAutoSync(date);
  });
  drawSets();

  $('#addSet').onclick = () => {
    const p = ex.sets[ex.sets.length - 1];
    ex.sets.push({ w: p ? p.w : '', r: p ? p.r : '', memo: '' });
    save(); drawSets(); scheduleAutoSync(date);
    const ins = box.querySelectorAll('input.num');
    ins[ins.length - 2].focus();
  };
  const cp = $('#copyLast');
  if (cp) cp.onclick = () => {
    const has = ex.sets.some((s) => s.w || s.r);
    if (has && !confirm('今の入力を前回の内容に置き換えますか？')) return;
    ex.sets = last.sets.map((s) => ({ w: s.w, r: s.r, memo: '' }));
    save(); drawSets(); scheduleAutoSync(date);
  };
  $('#delEx').onclick = () => {
    if (!confirm(`「${ex.name}」の記録を消しますか？`)) return;
    day.exercises.splice(idx, 1);
    cleanDay(date); save(); scheduleAutoSync(date);
    location.hash = `#/day/${date}`;
  };
  // 入力途中の空セットは画面を離れるときに片づける
  onLeave = () => {
    const d = db.days[date];
    if (d && d.exercises[idx] === ex) ex.sets = ex.sets.filter((s) => num(s.w) || num(s.r) || s.memo);
    cleanDay(date); save();
  };

  const tsec = $('#tsec'), tbtn = $('#tbtn');
  tsec.onchange = () => { db.settings.timer = Math.max(1, Math.round(num(tsec.value)) || 60); tsec.value = db.settings.timer; save(); };
  tbtn.onclick = () => {
    if (timer.id) { stopTimer(); return; }
    let left = db.settings.timer;
    const end = Date.now() + left * 1000;
    tbtn.textContent = 'STOP';
    timer.id = setInterval(() => {
      left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      tsec.value = left;
      if (!left) { stopTimer(); beep(); toast('休憩おわり！'); }
    }, 250);
  };
}
const timer = { id: 0 };
function stopTimer() {
  if (timer.id) clearInterval(timer.id);
  timer.id = 0;
  const b = $('#tbtn'), t = $('#tsec');
  if (b) b.textContent = 'START';
  if (t) t.value = db.settings.timer;
}
function beep() {
  try { navigator.vibrate && navigator.vibrate([300, 100, 300]); } catch {}
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.35, 0.7].forEach((t) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ac.destination);
      g.gain.setValueAtTime(0.3, ac.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + t + 0.25);
      o.start(ac.currentTime + t); o.stop(ac.currentTime + t + 0.3);
    });
  } catch {}
}

// ---------- 履歴 ----------
function viewHistory(main, name) {
  header('履歴 / 分析');
  const names = [...new Set(Object.values(db.days).flatMap((d) => d.exercises.map((e) => e.name)))];
  if (!name || !names.includes(name)) name = names.includes('ベンチプレス') ? 'ベンチプレス' : names[0] || '';
  const pts = Object.keys(db.days).sort().map((d) => {
    const e = db.days[d].exercises.find((x) => x.name === name);
    if (!e || !e.sets.length) return null;
    return { d, rm: Math.max(...e.sets.map((s) => rm(num(s.w), num(s.r)))), max: Math.max(...e.sets.map((s) => num(s.w))), vol: vol(e.sets) };
  }).filter(Boolean);
  const dates = Object.keys(db.days).filter((d) => db.days[d].exercises.length).sort().reverse();
  main.innerHTML = names.length ? `
  <div class="form"><select id="exSel">${names.map((n) => `<option ${n === name ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>
  <div class="chart">${chart(pts)}</div>
  <div class="sec">日別の記録</div>
  <div class="list">${dates.map((d) => {
    const st = syncState(d).state;
    return `<div class="it" data-d="${d}"><span class="grow">${label(d)}<br><small>${esc(db.days[d].exercises.map((e) => e.name).join('、'))}</small></span>
      <small>${Math.round(dayVol(db.days[d]))} kg${st === 'done' ? ' ✓' : st === 'empty' ? '' : ' 未送信'}</small></div>`;
  }).join('')}</div>` : '<div class="empty">まだ記録がありません</div>';
  const sel = $('#exSel');
  if (sel) sel.onchange = () => { location.hash = `#/history/${encodeURIComponent(sel.value)}`; };
  main.querySelectorAll('.it[data-d]').forEach((el) => (el.onclick = () => { location.hash = `#/day/${el.dataset.d}`; }));
}
function chart(pts) {
  if (pts.length < 1) return '<div class="empty">データなし</div>';
  const W = 600, H = 260, L = 44, R = 12, T = 16, B = 30;
  const vals = pts.flatMap((p) => [p.rm, p.max]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 10) { lo -= 5; hi += 5; }
  lo = Math.max(0, Math.floor(lo / 5) * 5); hi = Math.ceil(hi / 5) * 5;
  const x = (i) => (pts.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (pts.length - 1));
  const y = (v) => T + ((hi - v) * (H - T - B)) / (hi - lo);
  const line = (k, c) => `<polyline fill="none" stroke="${c}" stroke-width="2.5" points="${pts.map((p, i) => `${x(i)},${y(p[k])}`).join(' ')}"/>` +
    pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p[k])}" r="3.5" fill="${c}"/>`).join('');
  const grid = [0, 1, 2, 3, 4].map((g) => { const v = lo + ((hi - lo) * g) / 4; return `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e5e5e5"/><text x="${L - 6}" y="${y(v) + 4}" font-size="12" text-anchor="end" fill="#888">${Math.round(v)}</text>`; }).join('');
  const step = Math.max(1, Math.ceil(pts.length / 6));
  const xl = pts.map((p, i) => (i % step === 0 || i === pts.length - 1 ? `<text x="${x(i)}" y="${H - 8}" font-size="12" text-anchor="middle" fill="#888">${Number(p.d.slice(5, 7))}/${Number(p.d.slice(8))}</text>` : '')).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="推移グラフ">${grid}${xl}${line('rm', '#d63c38')}${line('max', '#999')}
    <text x="${L}" y="12" font-size="12" fill="#d63c38">● 推定1RM</text><text x="${L + 90}" y="12" font-size="12" fill="#999">● 最大重量</text></svg>`;
}

// ---------- 設定 ----------
function viewSettings(main) {
  header('設定');
  const s = db.settings;
  main.innerHTML = `
  <div class="sec">スプレッドシート連携（Google ドライブ）</div>
  <p class="note">スプレッドシートに Apps Script を入れて「ウェブアプリ」として公開し、その URL と合言葉を入れます。手順はこのアプリの README を見てね。</p>
  <div class="form">
    <label>Apps Script の URL（https://script.google.com/macros/s/…/exec）</label>
    <input id="s_url" value="${esc(s.url)}" placeholder="https://script.google.com/macros/s/xxxx/exec" autocomplete="off">
    <label>合言葉（スクリプトの SECRET と同じもの）</label>
    <input id="s_key" value="${esc(s.key)}" autocomplete="off">
    <label>シート名</label>
    <input id="s_sheet" value="${esc(s.sheet)}">
    <div class="two">
      <div><label>日付の列</label><input id="s_dateCol" value="${esc(s.dateCol)}"></div>
      <div><label>書き込む列</label><input id="s_col" value="${esc(s.col)}"></div>
      <div><label>種目の区切り</label><input id="s_sep" value="${esc(s.sep)}"></div>
    </div>
    <label class="chk"><input type="checkbox" id="s_auto" ${s.autoSync ? 'checked' : ''}>入力したら自動で書き込む（数秒後）</label>
  </div>
  <div class="btns"><button class="btn small" id="saveS">保存</button><button class="btn small outline" id="ping">接続テスト</button></div>
  <p class="note">書き込み例: ${esc(sheetText({ exercises: [{ name: 'ベンチプレス', sets: [{ w: '20', r: '10' }, { w: '40', r: '5' }] }, { name: 'スクワット', sets: [{ w: '60', r: '8' }] }] }))}</p>

  <div class="sec">バックアップ</div>
  <p class="note">記録はこの端末のブラウザに保存されています。機種変更やブラウザのデータ削除に備えてファイルに書き出せます。</p>
  <div class="btns">
    <button class="btn small outline" id="exp">ファイルに書き出す</button>
    <label class="btn small outline">ファイルから読み込む<input type="file" id="imp" accept="application/json,.json" hidden></label>
  </div>
  <p class="note" style="margin-top:24px">記録 ${Object.keys(db.days).length} 日分</p>`;
  const read = () => {
    s.url = $('#s_url').value.trim(); s.key = $('#s_key').value;
    s.sheet = $('#s_sheet').value.trim() || DEFAULT_SETTINGS.sheet;
    s.dateCol = $('#s_dateCol').value.trim().toUpperCase() || 'A';
    s.col = $('#s_col').value.trim().toUpperCase() || 'F';
    s.sep = $('#s_sep').value;
    s.autoSync = $('#s_auto').checked;
    save();
  };
  $('#saveS').onclick = () => { read(); toast('保存しました'); render(); };
  $('#ping').onclick = async (ev) => {
    read();
    ev.target.disabled = true;
    try { const j = await callGas({ action: 'ping' }); toast(`つながりました: 「${j.title}」の「${j.sheet}」シート`, 4000); } catch (e) { toast(e.message, 4000); }
    ev.target.disabled = false;
  };
  $('#exp').onclick = () => {
    const blob = new Blob([JSON.stringify(db, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `kintore-${today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  $('#imp').onchange = async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!d || typeof d.days !== 'object') throw new Error('形式が違います');
      if (!confirm('今の記録をファイルの内容で置き換えますか？')) return;
      localStorage.setItem(KEY, JSON.stringify(d));
      db = load();
      toast('読み込みました'); render();
    } catch (e) { toast('読み込めませんでした: ' + e.message); }
  };
}

// ---------- RM計算 ----------
function openRM() {
  const dlg = $('#dlg');
  dlg.innerHTML = `<h3>RM計算</h3>
  <div class="form two" style="grid-template-columns:1fr 1fr">
    <div><label>重さ (kg)</label><input id="rw" inputmode="decimal" value="60"></div>
    <div><label>回数</label><input id="rr" inputmode="numeric" value="5"></div>
  </div>
  <p>推定 1RM: <b id="rone" style="font-size:22px;color:var(--red)"></b></p>
  <table class="rmtable" id="rtab"></table>
  <div class="btns"><button class="btn small" id="rclose">閉じる</button></div>`;
  const upd = () => {
    const one = rm(num($('#rw').value), num($('#rr').value));
    $('#rone').textContent = one ? fmtW(Math.round(one * 10) / 10) + ' kg' : '-';
    $('#rtab').innerHTML = one ? [1, 2, 3, 4, 5, 6, 8, 10, 12, 15].map((r) =>
      `<tr><td>${r} 回</td><td>${fmtW(Math.round(one / (1 + r / 40) * 4) / 4)} kg</td><td>${Math.round(100 / (1 + r / 40))}%</td></tr>`).join('') : '';
  };
  dlg.addEventListener('input', upd);
  $('#rclose').onclick = () => dlg.close();
  upd();
  dlg.showModal();
}

// ---------- その他 ----------
let toastT = 0;
function toast(msg, ms = 2500) {
  const t = $('#toast');
  t.textContent = msg;
  t.style.whiteSpace = 'pre-line';
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), ms);
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
render();
