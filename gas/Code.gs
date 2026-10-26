// 筋トレメモ → スプレッドシート書き込み用の Apps Script
// 使い方は README.md を見てね。書き込みたいスプレッドシートの「拡張機能 → Apps Script」に貼り付けて使う

// 合言葉（アプリの設定に入れるものと同じにする）。URL を知っている人が勝手に書き込めないようにするため
const SECRET = 'ここを好きな合言葉に変える';

// 動作確認用: ブラウザで URL を開くと {"ok":true,...} が出る
function doGet() {
  return out({ ok: true, msg: '筋トレメモ用のスクリプトは動いています' });
}

// アプリからの書き込み
// { action: 'ping' | 'write', key, sheet, dateCol, col, date: '2026/10/25', text }
function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return out({ ok: false, error: '送られたデータが読めません' });
  }
  if (req.key !== SECRET) return out({ ok: false, error: '合言葉が違います' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheetName = req.sheet || '日次記録';
    const sh = ss.getSheetByName(sheetName);
    if (!sh) return out({ ok: false, error: 'シート「' + sheetName + '」が見つかりません' });
    if (req.action === 'ping') return out({ ok: true, title: ss.getName(), sheet: sh.getName() });
    if (req.action !== 'write') return out({ ok: false, error: '知らない操作です: ' + req.action });
    return out(writeDay(ss, sh, req));
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

// 日付の行を探して書き込む。なければ日付の並び順（新しい順/古い順）に合う場所へ行を追加する
function writeDay(ss, sh, req) {
  const tz = ss.getSpreadsheetTimeZone();
  const target = normDate(req.date, tz);
  if (!target) return { ok: false, error: '日付が読めません: ' + req.date };
  const dateCol = colIndex(req.dateCol || 'A');
  const col = colIndex(req.col || 'F');
  if (!dateCol || !col) return { ok: false, error: '列の指定が正しくありません' };
  const text = String(req.text == null ? '' : req.text);

  const header = 1; // 1行目は見出し
  const last = sh.getLastRow();
  const dates = last > header
    ? sh.getRange(header + 1, dateCol, last - header, 1).getValues().map(function (r) { return normDate(r[0], tz); })
    : [];

  // 同じ日付がある → その行の指定列だけ上書き
  const found = dates.indexOf(target);
  if (found >= 0) {
    const row = found + header + 1;
    const cell = sh.getRange(row, col);
    const prev = cell.getDisplayValue();
    cell.setValue(text);
    return { ok: true, mode: 'updated', row: row, prev: prev };
  }

  // ない → 並び順を見て差し込む場所を決める
  const dated = [];
  dates.forEach(function (v, k) { if (v) dated.push({ v: v, k: k }); });
  const desc = dated.length < 2 || dated[0].v >= dated[dated.length - 1].v;
  const pos = dated.find(function (x) { return desc ? x.v < target : x.v > target; });
  let row;
  if (pos) {
    row = pos.k + header + 1;
    sh.insertRowBefore(row);
  } else {
    row = last + 1;
    if (row > sh.getMaxRows()) sh.insertRowAfter(sh.getMaxRows());
  }
  // 日付の表示形式はとなりの行に合わせる
  const nb = row + 1 <= sh.getLastRow() ? row + 1 : row - 1;
  const dateCell = sh.getRange(row, dateCol);
  if (nb > header) dateCell.setNumberFormat(sh.getRange(nb, dateCol).getNumberFormat());
  dateCell.setValue(target);
  sh.getRange(row, col).setValue(text);
  return { ok: true, mode: 'inserted', row: row };
}

// 日付のセル（日付型・文字）を 'yyyy/MM/dd' にそろえる
function normDate(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy/MM/dd');
  const m = String(v || '').trim().match(/^(\d{4})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})/);
  if (!m) return '';
  return m[1] + '/' + ('0' + m[2]).slice(-2) + '/' + ('0' + m[3]).slice(-2);
}

// 'A' → 1, 'F' → 6, 'AA' → 27（数字ならそのまま）
function colIndex(c) {
  c = String(c).trim().toUpperCase();
  if (/^\d+$/.test(c)) return Number(c);
  if (!/^[A-Z]+$/.test(c)) return 0;
  let n = 0;
  for (let i = 0; i < c.length; i++) n = n * 26 + (c.charCodeAt(i) - 64);
  return n;
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
