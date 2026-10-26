'use strict';
// Google でログインして、スプレッドシートに直接書き込む（Sheets API）
// ログインの窓はボタンを押した流れでしか開けない（ポップアップ防止）ので、ensureToken() はクリックの中ですぐ呼ぶこと

const GSheets = (() => {
  const cfg = window.KINTORE_CONFIG || {};
  const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
  const TOKEN_KEY = 'kintore.gtoken';
  const API = 'https://sheets.googleapis.com/v4/spreadsheets/';
  let client = null;
  let pending = null;

  const available = () => !!cfg.googleClientId;

  // Google のログイン部品を読み込む
  let gisP = null;
  function loadGis() {
    if (!gisP) gisP = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = res;
      s.onerror = () => { gisP = null; rej(new Error('Google のログイン部品を読み込めませんでした')); };
      document.head.appendChild(s);
    });
    return gisP;
  }
  if (available()) loadGis().catch(() => {});

  function saved() {
    try {
      const t = JSON.parse(localStorage.getItem(TOKEN_KEY));
      if (t && t.token && t.exp > Date.now() + 60000) return t.token;
    } catch {}
    return '';
  }
  const hasToken = () => !!saved();

  // 有効な鍵（アクセストークン）を返す。なければログインの窓を開く
  function ensureToken(interactive = true) {
    const t = saved();
    if (t) return Promise.resolve(t);
    if (!interactive) return Promise.reject(new Error('Google へのログインが切れています（書き込みボタンを押すとログインし直せます）'));
    if (!window.google || !google.accounts || !google.accounts.oauth2) {
      return Promise.reject(new Error('Google のログイン部品を準備中です。少し待ってからもう一度押してください'));
    }
    if (!client) {
      client = google.accounts.oauth2.initTokenClient({
        client_id: cfg.googleClientId,
        scope: SCOPE,
        callback: (r) => {
          const p = pending; pending = null;
          if (!p) return;
          if (r.error) return p.rej(new Error('ログインできませんでした: ' + r.error));
          localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: r.access_token, exp: Date.now() + Number(r.expires_in || 3600) * 1000 }));
          p.res(r.access_token);
        },
        error_callback: (e) => {
          const p = pending; pending = null;
          if (p) p.rej(new Error(e && e.type === 'popup_closed' ? 'ログインの窓が閉じられました' : 'ログインできませんでした'));
        },
      });
    }
    return new Promise((res, rej) => {
      if (pending) pending.rej(new Error('ログインをやり直しました'));
      pending = { res, rej };
      // 一度許可していれば、次からは窓が一瞬開くだけで済む
      client.requestAccessToken({ prompt: localStorage.getItem(TOKEN_KEY) ? '' : 'consent' });
    });
  }
  function logout() {
    const t = saved();
    localStorage.removeItem(TOKEN_KEY);
    if (t && window.google && google.accounts) try { google.accounts.oauth2.revoke(t); } catch {}
  }

  async function api(token, path, opt = {}) {
    const res = await fetch(API + path, Object.assign({}, opt, {
      headers: Object.assign({ Authorization: 'Bearer ' + token }, opt.body ? { 'Content-Type': 'application/json' } : {}),
    }));
    if (res.status === 401) { localStorage.removeItem(TOKEN_KEY); throw new Error('Google へのログインが切れました。もう一度押してください'); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (j.error && j.error.message) || res.status;
      if (res.status === 404) throw new Error('スプレッドシートが見つかりません（URL を確認してください）');
      if (res.status === 403) throw new Error('このスプレッドシートに書き込む権限がありません: ' + msg);
      throw new Error('Google スプレッドシートのエラー: ' + msg);
    }
    return j;
  }

  // URL（https://docs.google.com/spreadsheets/d/ID/edit…）から ID を取り出す
  function parseId(s) {
    s = String(s || '').trim();
    const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    return /^[a-zA-Z0-9_-]{20,}$/.test(s) ? s : '';
  }

  const q = (sheet) => `'${String(sheet).replace(/'/g, "''")}'`;
  const colName = (n) => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
  const colIndex = (c) => { c = String(c).trim().toUpperCase(); if (/^\d+$/.test(c)) return Number(c); let n = 0; for (const ch of c) n = n * 26 + ch.charCodeAt(0) - 64; return /^[A-Z]+$/.test(c) ? n : 0; };

  // スプレッドシートの名前・シート一覧と、各シートの1行目（見出し）
  async function inspect(token, id) {
    const meta = await api(token, `${id}?fields=properties.title,sheets.properties(sheetId,title)`);
    const sheets = meta.sheets.map((s) => s.properties.title);
    const r = await api(token, `${id}/values:batchGet?${sheets.map((s) => 'ranges=' + encodeURIComponent(q(s) + '!1:1')).join('&')}`);
    const headers = {};
    sheets.forEach((s, i) => { headers[s] = ((r.valueRanges[i] || {}).values || [[]])[0] || []; });
    return { title: meta.properties.title, sheets, headers };
  }
  // 見出しから「日付」「筋トレ」の列を見つける
  function guessCols(header) {
    const find = (re) => { const i = header.findIndex((h) => re.test(String(h))); return i >= 0 ? colName(i + 1) : ''; };
    return { dateCol: find(/日付|date/i) || 'A', col: find(/筋トレ|トレーニング|workout/i) || '' };
  }

  // 日付の書き方（2026/9/9・2026-09-09・2026年9月9日）を 'yyyy/MM/dd' にそろえる
  function normDate(v) {
    const m = String(v || '').trim().match(/^(\d{4})\s*[\/\-.年]\s*(\d{1,2})\s*[\/\-.月]\s*(\d{1,2})/);
    return m ? `${m[1]}/${m[2].padStart(2, '0')}/${m[3].padStart(2, '0')}` : '';
  }

  // 日付の行を探して書き込む。なければ並び順（新しい順/古い順）に合う場所へ行を追加する
  async function writeDay(token, { id, sheet, dateCol, col, date, text }) {
    const dc = colIndex(dateCol), wc = colIndex(col);
    if (!dc || !wc) throw new Error('列の指定が正しくありません');
    const target = normDate(date);
    const header = 1;
    const DC = colName(dc), WC = colName(wc);
    const r = await api(token, `${id}/values/${encodeURIComponent(`${q(sheet)}!${DC}${header + 1}:${DC}`)}?valueRenderOption=FORMATTED_VALUE`);
    const dates = (r.values || []).map((row) => normDate(row[0]));

    const found = dates.indexOf(target);
    if (found >= 0) {
      const row = found + header + 1;
      const cell = `${q(sheet)}!${WC}${row}`;
      const prev = await api(token, `${id}/values/${encodeURIComponent(cell)}`);
      await api(token, `${id}/values/${encodeURIComponent(cell)}?valueInputOption=RAW`, { method: 'PUT', body: JSON.stringify({ values: [[text]] }) });
      return { ok: true, mode: 'updated', row, prev: ((prev.values || [[]])[0] || [])[0] || '' };
    }

    const dated = [];
    dates.forEach((v, k) => { if (v) dated.push({ v, k }); });
    const desc = dated.length < 2 || dated[0].v >= dated[dated.length - 1].v;
    const pos = dated.find((x) => (desc ? x.v < target : x.v > target));
    const row = pos ? pos.k + header + 1 : dates.length + header + 1;
    const meta = await api(token, `${id}?fields=sheets.properties(sheetId,title,gridProperties.rowCount)`);
    const sh = meta.sheets.find((s) => s.properties.title === sheet);
    if (!sh) throw new Error(`シート「${sheet}」が見つかりません`);
    const sheetId = sh.properties.sheetId;
    let req = null;
    // 途中に差し込むときは行を挿入（書式は下の行からもらう）。末尾で行が足りなければ1行足す
    if (pos) req = { insertDimension: { range: { sheetId, dimension: 'ROWS', startIndex: row - 1, endIndex: row }, inheritFromBefore: false } };
    else if (row > sh.properties.gridProperties.rowCount) req = { appendDimension: { sheetId, dimension: 'ROWS', length: 1 } };
    if (req) await api(token, `${id}:batchUpdate`, { method: 'POST', body: JSON.stringify({ requests: [req] }) });
    // 日付は手で打ったのと同じ扱い（日付として認識される）、内容はそのままの文字で入れる
    await api(token, `${id}/values:batchUpdate`, { method: 'POST', body: JSON.stringify({ data: [
      { range: `${q(sheet)}!${DC}${row}`, values: [[target]] },
    ], valueInputOption: 'USER_ENTERED' }) });
    await api(token, `${id}/values/${encodeURIComponent(`${q(sheet)}!${WC}${row}`)}?valueInputOption=RAW`, { method: 'PUT', body: JSON.stringify({ values: [[text]] }) });
    return { ok: true, mode: 'inserted', row };
  }

  return { available, hasToken, ensureToken, logout, parseId, inspect, guessCols, writeDay, normDate, colIndex };
})();
