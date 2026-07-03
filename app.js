'use strict';

/* =========================================================
   震析 SHIN-SEKI — 地震学解析ツール
   - 震央分布 / b値解析 / 震源球
   ========================================================= */

const STYLE_URL = 'https://demotiles.maplibre.org/style.json'; // フォールバック用の軽量ベースマップ
// ArcGIS Online「World Dark Gray Base」（Esri Canvas）を使用した暗色ベースマップ
const DARK_STYLE = {
  version: 8,
  glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf',
  sources: {
    'esri-dark-gray': {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/arcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'
      ],
      tileSize: 256,
      maxzoom: 16,
      attribution: 'Tiles &copy; Esri'
    }
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#0b0d11' } },
    { id: 'esri-dark-gray-layer', type: 'raster', source: 'esri-dark-gray', paint: { 'raster-opacity': 1 } }
  ]
};

const JAPAN_CENTER = [138.5, 37.0];

// 気象庁「震央地名コード」表（地震火山関連コード表 AreaEpicenter）
// code_id -> [英語名, 日本語名]。JMAのhypo GeoJSONは震央地名を英語名で返すため、
// この表を使って日本語表記に変換する。
/* ---------------------------------------------------------
   震央地名（経緯度 -> 日本語地名）
   気象庁hypo GeoJSONの place プロパティは独自の英語略記
   （例: "E OFF FUKUSHIMA PREF"）で入っており、コード表との
   文字列マッチングでは変換しきれないケースが多かったため、
   経緯度から直接震央地名を引く方式に変更する。

   データ出典: ll2epiname（経緯度から震央地名を求めるための対応表）
   https://github.com/compo031/ll2epiname （MIT License, (c) 2021 compo031）
   epiname_data.js（別ファイル）を fetch して読み込み、
   「緯度1分帯ごとの経度境界点リスト」から最近傍探索で地名を求める。
--------------------------------------------------------- */

let epinameGrid = null;   // Map<latKey(度*60+分), Array<[lonKey, nameIdx]>>（経度昇順）
let epinameNames = null;  // string[]
let epinameSortedLatKeys = null; // number[]（昇順）
let epinameLoadPromise = null;

function parseEpinameData() {
  const rawNames = window.EPINAME_LIST;
  const rawGrid = window.EPINAME_GRID_RAW;
  if (!rawNames || !rawGrid) throw new Error('EPINAME data not found');

  epinameNames = rawNames;
  epinameGrid = new Map();

  const latRows = rawGrid.split(';');
  for (const row of latRows) {
    if (!row) continue;
    const colonIdx = row.indexOf(':');
    const latKey = parseInt(row.slice(0, colonIdx), 36);
    const entriesStr = row.slice(colonIdx + 1);
    const entries = [];
    let prevLon = 0;
    if (entriesStr) {
      for (const pair of entriesStr.split(',')) {
        const [diffStr, idxStr] = pair.split('_');
        const diff = parseInt(diffStr, 36);
        const idx = parseInt(idxStr, 36);
        prevLon += diff;
        entries.push([prevLon, idx]);
      }
    }
    epinameGrid.set(latKey, entries);
  }
  epinameSortedLatKeys = Array.from(epinameGrid.keys()).sort((a, b) => a - b);
}

async function loadEpinameData() {
  if (epinameLoadPromise) return epinameLoadPromise;
  epinameLoadPromise = (async () => {
    try {
      // 既にグローバルに載っている場合（他経路での読み込み）はそのまま使う
      if (!window.EPINAME_LIST || !window.EPINAME_GRID_RAW) {
        await loadScriptOnce('epiname_data.js');
      }
      parseEpinameData();
    } catch (e) {
      console.error('震央地名データの読み込みに失敗しました:', e);
      toast('震央地名データの読み込みに失敗しました');
    }
  })();
  return epinameLoadPromise;
}

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-epiname-src="${src}"]`);
    if (existing) { existing.addEventListener('load', resolve); existing.addEventListener('error', reject); return; }
    const el = document.createElement('script');
    el.src = src;
    el.dataset.epinameSrc = src;
    el.onload = resolve;
    el.onerror = reject;
    document.head.appendChild(el);
  });
}

// 昇順配列から値に最も近い要素のインデックスを二分探索で求める
function nearestIndexSorted(sortedArr, value) {
  let lo = 0, hi = sortedArr.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedArr[mid] < value) lo = mid + 1; else hi = mid;
  }
  // lo は value 以上になる最初の位置。前後どちらが近いか比較する。
  if (lo > 0) {
    const prev = sortedArr[lo - 1];
    const cur = sortedArr[lo];
    if (Math.abs(prev - value) <= Math.abs(cur - value)) return lo - 1;
  }
  return lo;
}

// 経緯度（10進度）から震央地名（日本語）を求める。
// データ未読み込み・範囲外などで求まらない場合は null を返す。
function lookupEpicenterName(lon, lat) {
  if (lon == null || lat == null || isNaN(lon) || isNaN(lat)) return null;
  if (!epinameGrid || !epinameSortedLatKeys || !epinameNames) return null;
  if (epinameSortedLatKeys.length === 0) return null;

  // 度→分変換時の浮動小数点誤差（例: 135+10/60 の *60 が 8109.999999999999
  // になる）で境界値ちょうどの地点が隣の区間に引き込まれるのを防ぐため、
  // 小さなイプシロンを加えてから丸める。
  const EPS = 1e-6;
  const latKeyF = lat * 60 + EPS;
  const latIdx = nearestIndexSorted(epinameSortedLatKeys, latKeyF);
  if (latIdx < 0) return null;
  const latKey = epinameSortedLatKeys[latIdx];
  const entries = epinameGrid.get(latKey);
  if (!entries || entries.length === 0) return null;

  const lonKeyF = lon * 60 + EPS;
  // entries は経度昇順。lonKeyF 以下で最大の境界点（区間の開始点）を採用する。
  let idx = -1;
  let loI = 0, hiI = entries.length - 1;
  while (loI <= hiI) {
    const mid = (loI + hiI) >> 1;
    if (entries[mid][0] <= lonKeyF) { idx = mid; loI = mid + 1; } else { hiI = mid - 1; }
  }
  if (idx < 0) idx = 0; // 区間の先頭より西側なら先頭区間を採用
  const nameIdx = entries[idx][1];
  return epinameNames[nameIdx] || null;
}


function toast(msg, ms = 4200) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

function pad2(n) { return String(n).padStart(2, '0'); }

/* ---------------------------------------------------------
   日付フィールド（気象庁の震源検索と同じ、年/月/日を個別セグメントで直接入力）
   以前は <input type="date"> を透明化してその上に YYYY/MM/DD の表示を
   重ねる方式だったが、WebKitのフォーカス中サブフィールドの色が
   透明化しきれない不具合があった。ブラウザのロケール・実装差異に
   依存しないよう、年(4桁)・月(2桁)・日(2桁)をそれぞれ独立した
   <input type="text" inputmode="numeric"> として自前で描画し、
   規定桁数まで入力したら自動的に次のセグメントへフォーカスを移す。
   実際の値は <input type="hidden" id="{id}"> に "YYYY-MM-DD" 形式で
   保持し、既存コード（document.getElementById(id).value を読む箇所）
   との互換性を保つ。カレンダーアイコンからは透明化した
   <input type="date"> 経由でネイティブピッカーも呼び出せる。
--------------------------------------------------------- */

// id を指定して、気象庁方式の日付フィールドのHTMLを生成する。
// isoValue は "YYYY-MM-DD" 形式（空文字列も可）。
function createDateFieldHTML(id, isoValue) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoValue || '');
  const y = m ? m[1] : '';
  const mo = m ? m[2] : '';
  const d = m ? m[3] : '';
  return `
    <div class="date-field" data-date-field-id="${id}">
      <input type="hidden" id="${id}" value="${isoValue || ''}">
      <input class="date-seg seg-y" type="text" inputmode="numeric" maxlength="4" placeholder="年" data-seg="y" value="${y}">
      <span class="date-sep">/</span>
      <input class="date-seg seg-m" type="text" inputmode="numeric" maxlength="2" placeholder="月" data-seg="m" value="${mo}">
      <span class="date-sep">/</span>
      <input class="date-seg seg-d" type="text" inputmode="numeric" maxlength="2" placeholder="日" data-seg="d" value="${d}">
      <button type="button" class="date-field-cal-btn" title="カレンダーから選択">
        <svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>
        <input type="date" tabindex="-1" aria-hidden="true" value="${isoValue || ''}">
      </button>
    </div>`;
}

// createDateFieldHTML で生成したフィールドにイベントを配線する。
// onChange(isoStrOrEmpty) は値が確定するたびに呼ばれる。
function bindDateField(id, onChange) {
  const root = document.querySelector(`.date-field[data-date-field-id="${id}"]`);
  if (!root) return;
  const hidden = document.getElementById(id);
  const segY = root.querySelector('[data-seg="y"]');
  const segM = root.querySelector('[data-seg="m"]');
  const segD = root.querySelector('[data-seg="d"]');
  const calInput = root.querySelector('.date-field-cal-btn input[type="date"]');

  function currentIso() {
    const y = segY.value.trim();
    const mo = segM.value.trim();
    const d = segD.value.trim();
    if (y.length === 4 && mo.length >= 1 && d.length >= 1) {
      const isoStr = `${y}-${pad2(Number(mo))}-${pad2(Number(d))}`;
      // 実在する日付かどうか検証する（例: 2026-02-30のような不正値を弾く）
      const dt = new Date(isoStr + 'T00:00:00');
      if (!isNaN(dt) && dt.getFullYear() === Number(y) && dt.getMonth() + 1 === Number(mo) && dt.getDate() === Number(d)) {
        return isoStr;
      }
    }
    return '';
  }

  function commit() {
    const iso = currentIso();
    hidden.value = iso;
    if (calInput) calInput.value = iso;
    if (onChange) onChange(iso);
  }

  // 数字以外の入力を除去しつつ、規定桁数に達したら次のセグメントへ自動移動する
  function wireSegment(el, maxLen, next) {
    el.addEventListener('input', () => {
      const digits = el.value.replace(/\D/g, '').slice(0, maxLen);
      el.value = digits;
      if (digits.length >= maxLen && next) next.focus();
      commit();
    });
    el.addEventListener('blur', () => {
      // 月・日は1桁入力でも0埋めして見た目を揃える（年は4桁必須のためそのまま）
      if (el.dataset.seg !== 'y' && el.value.length === 1) {
        el.value = pad2(Number(el.value));
      }
      commit();
    });
    el.addEventListener('keydown', (e) => {
      // BackSpaceで空の状態から前のセグメントへ戻る（気象庁UIと同様の操作感）
      if (e.key === 'Backspace' && el.selectionStart === 0 && el.selectionEnd === 0) {
        const prev = el === segD ? segM : (el === segM ? segY : null);
        if (prev) { prev.focus(); prev.setSelectionRange(prev.value.length, prev.value.length); }
      }
    });
    el.addEventListener('focus', () => { el.select(); });
  }
  wireSegment(segY, 4, segM);
  wireSegment(segM, 2, segD);
  wireSegment(segD, 2, null);

  // カレンダーアイコンからネイティブピッカーで選んだ場合は、その値をセグメントに反映する
  if (calInput) {
    calInput.addEventListener('change', () => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(calInput.value || '');
      if (m) {
        segY.value = m[1]; segM.value = m[2]; segD.value = m[3];
        commit();
      }
    });
  }
}

// 気象庁方式フィールドの現在値（"YYYY-MM-DD"）を取得するユーティリティ。
// 実体は <input type="hidden" id="{id}"> なので document.getElementById(id).value と等価だが、
// 呼び出し側の可読性のために用意する。
function getDateFieldValue(id) {
  const el = document.getElementById(id);
  return el ? el.value : '';
}

/* ---------------------------------------------------------
   タブ切替
   すべてのビューは起動時に一度だけ初期化し、タブ切替では表示/非表示の
   CSS切替（visibility）のみを行う。これにより切替時のパネル再構築を防ぐ。

   地図は「震央分布」「b値解析」の2ビューで単一のMapLibreインスタンスを
   共有する（#map-shared）。以前はタブ切替のたびに appendChild で
   #map-shared をactiveな.view内へ移動させていたが、DOM移動はWebGLの
   canvasにとってコンテキストの再アタッチに相当し、環境によっては一瞬
   フレームが失われて「再描画」に見える現象の原因になっていた。
   そのため #map-shared は #app 直下に固定したまま一切動かさず、
   表示するレイヤーのみを sharedMap.setLayoutProperty(...,'visibility',...)
   で切り替える方式にする。地図はどちらのタブでも同じ位置に存在し続け、
   .view側は震央分布・b値解析それぞれのフローティングパネル（操作UI）
   だけを保持する。
--------------------------------------------------------- */
const tabButtons = document.querySelectorAll('.tab-btn');
const views = document.querySelectorAll('.view');

// ビューID -> そのビューがアクティブな時に表示すべきレイヤーID群
// quake-circles（震源円）は震央分布・b値解析のどちらでも同じ見た目で
// 表示する共通レイヤーなので、両方のビューに含めておく。
// view-mech（震源球）は元々 #mech-scroll が不透明な背景(--bg-0)と
// z-index:40 で #map-shared を完全に覆い隠す構造になっており、地図は
// そもそも見えない。そのため view-mech はこのテーブルに含めず、
// 震源球タブへの切り替え時は地図レイヤーの visibility に一切触れない
// ようにする（見えない地図のレイヤーを毎回 none/visible と切り替える
// のは無駄な再描画の原因になるだけで、見た目には何の意味も無いため）。
const VIEW_LAYERS = {
  'view-epicenter': ['quake-circles'],
  'view-bvalue': ['quake-circles', 'bv-bbox-fill', 'bv-bbox-line']
};
const ALL_SHARED_LAYERS = [...new Set(Object.values(VIEW_LAYERS).flat())];

function applyLayerVisibilityFor(viewId) {
  // view-mech のように VIEW_LAYERS に定義が無いビューでは、地図レイヤーの
  // 状態を一切変更しない（直前の震央分布/b値解析の表示状態をそのまま
  // 保持する）。地図はどうせ見えていないので、状態を変える必要が無い。
  if (!Object.prototype.hasOwnProperty.call(VIEW_LAYERS, viewId)) return;
  if (!sharedMap || !sharedMap.isStyleLoaded()) return;
  const visibleSet = new Set(VIEW_LAYERS[viewId] || []);
  for (const layerId of ALL_SHARED_LAYERS) {
    if (!sharedMap.getLayer(layerId)) continue;
    sharedMap.setLayoutProperty(layerId, 'visibility', visibleSet.has(layerId) ? 'visible' : 'none');
  }
}

function activateView(targetId) {
  tabButtons.forEach(b => b.classList.toggle('active', b.dataset.view === targetId));
  views.forEach(v => v.classList.toggle('active', v.id === targetId));

  // 地図要素そのものは #app 直下に固定済みで、ここでは一切DOM操作をしない。
  // 表示するレイヤーの切り替えのみ行う（震源球タブでは何もしない）。
  applyLayerVisibilityFor(targetId);
}

tabButtons.forEach(btn => {
  btn.addEventListener('click', () => activateView(btn.dataset.view));
});


/* ---------------------------------------------------------
   JMA 震源データ取得ユーティリティ
   URL: https://www.jma.go.jp/bosai/hypo/data/YYYY/MM/hypoYYYYMMDD.geojson
--------------------------------------------------------- */
function hypoUrlFor(dateObj) {
  const y = dateObj.getFullYear();
  const m = pad2(dateObj.getMonth() + 1);
  const d = pad2(dateObj.getDate());
  return `https://www.jma.go.jp/bosai/hypo/data/${y}/${m}/hypo${y}${m}${d}.geojson`;
}

function dateRange(startStr, endStr) {
  const out = [];
  const start = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');
  if (isNaN(start) || isNaN(end) || start > end) return out;
  const cur = new Date(start);
  while (cur <= end) {
    out.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

// JMA hypo GeoJSON の properties は資料により項目名が揺れる可能性があるため、
// 代表的なキー候補からフォールバック取得する
function pickProp(props, keys, fallback = null) {
  for (const k of keys) {
    if (props[k] !== undefined && props[k] !== null) return props[k];
  }
  return fallback;
}

function normalizeFeature(feature) {
  const p = feature.properties || {};
  const coords = (feature.geometry && feature.geometry.coordinates) || [null, null, null];
  const lon = coords[0];
  const lat = coords[1];
  // JMAのhypo GeoJSONは深さがgeometry.coordinates[2]ではなく
  // properties.dep（km単位の文字列、例: "36.0"）に入っている。
  // coordinates[2]が存在する場合はそちらを優先しつつ、
  // 高度(+上向き)で入っている可能性を考慮して符号を正規化する。
  let depth = coords[2];
  if (depth === undefined || depth === null) {
    const depRaw = pickProp(p, ['dep', 'depth'], null);
    depth = depRaw !== null ? Number(depRaw) : null;
  }
  if (depth !== undefined && depth !== null && !isNaN(depth) && depth < 0) depth = -depth;
  if (depth !== null && isNaN(depth)) depth = null;

  const mag = Number(pickProp(p, ['mag', 'magnitude', 'Magunitude', 'M'], NaN));
  const timeRaw = pickProp(p, ['time', 'origin_time', 'at', 'date'], null);
  // 震央地名はJMAのplace文字列（独自の英語略記で表記ゆれが大きい）を
  // 使わず、経緯度からll2epinameデータで直接求める。データ未読み込みや
  // 範囲外などで求まらない場合のみ、JMAのplace文字列（英語）にフォール
  // バックする。
  const placeRaw = pickProp(p, ['place', 'epi', 'region', 'name'], null);
  const placeByCoord = lookupEpicenterName(lon, lat);
  const place = placeByCoord || placeRaw || '不明';
  const maxInt = pickProp(p, ['maxInt', 'max_int', 'maxi', 'intensity'], null);

  let timeMs = null;
  if (timeRaw) {
    const t = new Date(timeRaw);
    if (!isNaN(t)) timeMs = t.getTime();
  }

  return {
    lon, lat, depth,
    mag: isNaN(mag) ? null : mag,
    time: timeMs,
    timeRaw,
    place,
    maxInt,
    raw: p
  };
}

// 日毎の取得結果をキャッシュし、震央分布／b値解析の両ビューで共有する。
// これにより、片方のビューで取得済みの日付はもう一方のビューで再取得されない。
const hypoDayCache = new Map(); // key: 'YYYY-MM-DD' -> { features, error }

function dayKey(dateObj) {
  return `${dateObj.getFullYear()}-${pad2(dateObj.getMonth() + 1)}-${pad2(dateObj.getDate())}`;
}

async function fetchHypoDay(dateObj, { signal } = {}) {
  const url = hypoUrlFor(dateObj);
  // 震央地名データ（ll2epiname）の読み込みを待つ。初回以降はキャッシュ
  // 済みのPromiseが即座に解決するためオーバーヘッドはほぼ無い。
  await loadEpinameData();
  const res = await fetch(url, { signal, mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
  const gj = await res.json();
  const feats = (gj.features || []).map(normalizeFeature).filter(f => f.lon != null && f.lat != null);
  return feats;
}

async function fetchHypoRange(dates, onProgress) {
  const all = [];
  let done = 0;
  let cacheHits = 0;
  const errors = [];
  for (const d of dates) {
    const key = dayKey(d);
    const cached = hypoDayCache.get(key);
    if (cached) {
      // 当日分はまだ確定していない可能性があるため、今日の日付はキャッシュを使わず再取得する
      const isToday = key === dayKey(new Date());
      if (!isToday) {
        if (cached.error) errors.push({ date: d, error: cached.error });
        else all.push(...cached.features);
        done++; cacheHits++;
        if (onProgress) onProgress(done, dates.length, errors, cacheHits);
        continue;
      }
    }
    try {
      const feats = await fetchHypoDay(d);
      hypoDayCache.set(key, { features: feats, error: null });
      all.push(...feats);
    } catch (e) {
      hypoDayCache.set(key, { features: [], error: e });
      errors.push({ date: d, error: e });
    }
    done++;
    if (onProgress) onProgress(done, dates.length, errors, cacheHits);
  }
  return { features: all, errors, cacheHits };
}

// 指定された日付範囲が全てキャッシュ済み（当日分は除く）かどうかを判定する
function isRangeFullyCached(dates) {
  const todayKey = dayKey(new Date());
  return dates.every(d => {
    const key = dayKey(d);
    return key !== todayKey && hypoDayCache.has(key);
  });
}

// キャッシュのみから即座にデータを組み立てる（ネットワークアクセスなし）
function buildFromCache(dates) {
  const all = [];
  const errors = [];
  for (const d of dates) {
    const cached = hypoDayCache.get(dayKey(d));
    if (!cached) continue;
    if (cached.error) errors.push({ date: d, error: cached.error });
    else all.push(...cached.features);
  }
  return { features: all, errors };
}

/* =========================================================
   共有地図（震央分布 / b値解析）
   1つのMapLibreインスタンス（sharedMap）を両ビューで使い回す。
   タブ切替時はコンテナ要素ごとactiveな.viewへ再親付けし、
   表示するレイヤーのみをvisibility切替する（タブ切替のセクション参照）。
   ========================================================= */
let sharedMap = null;

// 震央分布・b値解析で共有する期間・取得済み生データ。
// 以前は epicenterState / bvalueState がそれぞれ独自の startDate/endDate と
// デフォルト値（7日 / 30日）を持っていたため、起動時に非同期の初期フェッチが
// 競合し、タブ切替のたびに「別の期間・別のデータ」が地図にセットされて
// 再描画されたように見えていた。日付範囲と生データ（rawFeatures）は
// このオブジェクト1つに統一し、震央分布・b値解析の両パネルが同じものを参照する。
let sharedDateRange = { startDate: null, endDate: null, rawFeatures: null };

let epicenterState = { data: [], startDate: null, endDate: null };

function magColor(mag) {
  if (mag == null) return '#8a8f9a';
  if (mag < 3) return '#4fc3f7';
  if (mag < 4) return '#39d98a';
  if (mag < 5) return '#f9d55c';
  if (mag < 6) return '#ff9f43';
  if (mag < 7) return '#ff5470';
  return '#d63aff';
}

function magRadius(mag) {
  if (mag == null) return 3;
  return Math.max(3, Math.min(22, mag * 3.2));
}

function featuresToGeoJSON(feats) {
  return {
    type: 'FeatureCollection',
    features: feats.map(f => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [f.lon, f.lat] },
      properties: {
        mag: f.mag,
        depth: f.depth,
        place: f.place,
        time: f.timeRaw,
        maxInt: f.maxInt,
        color: magColor(f.mag),
        radius: magRadius(f.mag)
      }
    }))
  };
}

// 震央分布・b値解析のどちらのタブでデータを取得しても、
// 1) 共有ソース(quake-src)への反映
// 2) 両方の state（epicenterState.data / bvalueState.data）の更新
// 3) （既に構築済みなら）b値パネルの再計算・再描画
// を必ずまとめて行うための共通処理。
// 以前はrunEpicenterFetch/runBvalueFetchがそれぞれ個別にsetDataするだけで
// 互いのstateやパネル表示を更新していなかったため、震央分布タブで取得した
// データがb値解析パネルの「データを取得してください」表示に反映されない
// 不具合があった。
function applySharedFeatures(rawFeatures) {
  const src = sharedMap.getSource('quake-src');
  if (src) src.setData(featuresToGeoJSON(rawFeatures));

  epicenterState.data = rawFeatures;
  bvalueState.data = rawFeatures.filter(f => f.mag != null);

  // b値パネルが既に構築されていれば、結果表示も同時に更新する
  if (document.getElementById('bv-result')) {
    computeAndRenderBvalue();
  }
}

function initSharedMap() {
  sharedMap = new maplibregl.Map({
    container: 'map-shared',
    style: DARK_STYLE,
    center: JAPAN_CENTER,
    zoom: 4.4,
    attributionControl: { compact: true }
  });
  sharedMap.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

  sharedMap.on('load', () => {
    // --- 地震データソース（震央分布・b値解析で共通の1つのソースを使う） ---
    // 生データは1箇所（quake-src）にだけ setData すれば、
    // 震央分布・b値解析の両ビューへ同時に反映される。
    sharedMap.addSource('quake-src', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

    // --- 震源円レイヤー：震央分布・b値解析の両ビューで完全に同一のレイヤーを
    //     共有する（見た目を変える理由が無いため）。以前は epi-circles /
    //     bv-circles という別レイヤーに分かれ、半径・色・不透明度が
    //     食い違っていたため、タブ切替のたびに同じ地震データの見た目が
    //     変わって「再描画されている」ように見える原因になっていた。 ---
    sharedMap.addLayer({
      id: 'quake-circles',
      type: 'circle',
      source: 'quake-src',
      paint: {
        'circle-radius': ['get', 'radius'],
        'circle-color': ['get', 'color'],
        'circle-opacity': 0.65,
        'circle-stroke-width': 1,
        'circle-stroke-color': 'rgba(255,255,255,0.35)'
      }
    });

    sharedMap.on('click', 'quake-circles', (e) => {
      const feature = e.features[0];
      const p = feature.properties;
      // ポップアップの位置は「クリックした画面上の座標」(e.lngLat)ではなく、
      // 震源そのものの座標(geometry.coordinates)を使う。
      // 円には半径があるため、高いズームでは円の端をクリックすることが多く、
      // e.lngLat をそのまま使うと「クリックした地点」の座標でポップアップが
      // 固定されてしまう。その後ズームアウトすると、円は正しい震源位置に
      // 描画され続ける一方でポップアップは元のクリック地点のままなので、
      // 円とポップアップの位置が食い違って見えるズレの原因になっていた。
      const coords = feature.geometry.coordinates.slice();
      const html = `
        <div class="font-num" style="font-family:var(--font-base); font-size:12px; line-height:1.6;">
          <div style="font-weight:700; font-size:13px; margin-bottom:4px;">${p.place || '不明'}</div>
          M ${p.mag != null ? p.mag.toFixed(1) : '—'} / 深さ ${p.depth != null ? Math.round(p.depth) + 'km' : '—'}<br>
          ${p.time ? new Date(p.time).toLocaleString('ja-JP') : ''}
        </div>`;
      new maplibregl.Popup({ closeButton: true })
        .setLngLat(coords)
        .setHTML(html)
        .addTo(sharedMap);
    });
    sharedMap.on('mouseenter', 'quake-circles', () => sharedMap.getCanvas().style.cursor = 'pointer');
    sharedMap.on('mouseleave', 'quake-circles', () => sharedMap.getCanvas().style.cursor = '');

    sharedMap.addSource('bv-bbox', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    sharedMap.addLayer({
      id: 'bv-bbox-fill',
      type: 'fill',
      source: 'bv-bbox',
      paint: { 'fill-color': '#ff9f43', 'fill-opacity': 0.08 }
    });
    sharedMap.addLayer({
      id: 'bv-bbox-line',
      type: 'line',
      source: 'bv-bbox',
      paint: { 'line-color': '#ff9f43', 'line-width': 1.6, 'line-dasharray': [2, 2] }
    });

    // 震源円レイヤーは常に表示。b値解析の範囲表示（bv-bbox）は
    // 初期状態の「震央分布」タブでは非表示にしておく。
    sharedMap.setLayoutProperty('bv-bbox-fill', 'visibility', 'none');
    sharedMap.setLayoutProperty('bv-bbox-line', 'visibility', 'none');

    setupBboxDrawing();
    buildEpicenterPanel();
    buildBvaluePanel();
  });
}

function defaultDateStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function buildEpicenterPanel() {
  const container = document.getElementById('view-epicenter');
  const panel = document.createElement('div');
  panel.className = 'floating-panel glass-panel';
  panel.style.cssText = 'top:16px; left:12px; width:230px;';
  // 期間の初期値は震央分布・b値解析で共有する（sharedDateRange）。
  // 未取得ならデフォルトで直近7日を提示する。
  const initStart = sharedDateRange.startDate || defaultDateStr(-7);
  const initEnd = sharedDateRange.endDate || defaultDateStr(0);
  panel.innerHTML = `
    <div class="panel-title"><span class="bar"></span>震央分布 — 期間指定</div>
    <label class="field-label">開始日</label>
    ${createDateFieldHTML('epi-start', initStart)}
    <div style="height:8px;"></div>
    <label class="field-label">終了日</label>
    ${createDateFieldHTML('epi-end', initEnd)}
    <div style="height:12px;"></div>
    <button class="btn btn-accent" id="epi-fetch" style="width:100%;">データ取得</button>
    <div style="height:10px;"></div>
    <div class="status-text" id="epi-status">待機中</div>
    <div class="divider"></div>
    <button type="button" class="panel-title" id="epi-legend-toggle" style="
      margin-bottom:0; width:100%; background:none; border:none; padding:0; cursor:pointer;
      display:flex; align-items:center; justify-content:space-between; gap:6px;
      font-family:var(--font-base); font-size:11px; font-weight:700; letter-spacing:0.08em; color:var(--text-2);
    ">
      <span style="display:flex; align-items:center; gap:6px;"><span class="bar"></span>凡例（M）</span>
      <svg id="epi-legend-caret" viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" fill="none" stroke-width="2" style="transition:transform .2s ease;"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div id="epi-legend-body" style="margin-top:8px;">
      <div class="legend-row"><span class="legend-swatch" style="background:#4fc3f7;"></span>&lt; 3.0</div>
      <div class="legend-row"><span class="legend-swatch" style="background:#39d98a;"></span>3.0–3.9</div>
      <div class="legend-row"><span class="legend-swatch" style="background:#f9d55c;"></span>4.0–4.9</div>
      <div class="legend-row"><span class="legend-swatch" style="background:#ff9f43;"></span>5.0–5.9</div>
      <div class="legend-row"><span class="legend-swatch" style="background:#ff5470;"></span>6.0–6.9</div>
      <div class="legend-row"><span class="legend-swatch" style="background:#d63aff;"></span>≥ 7.0</div>
    </div>
  `;
  container.appendChild(panel);

  // 凡例は初期状態で閉じておき、必要な時だけ開けるようにする
  // （大きな地震のマーカーが地図上で凡例パネルに重なって見づらくなるため）
  const legendBody = panel.querySelector('#epi-legend-body');
  const legendCaret = panel.querySelector('#epi-legend-caret');
  const legendToggle = panel.querySelector('#epi-legend-toggle');
  legendBody.style.display = 'none';
  legendToggle.addEventListener('click', () => {
    const isOpen = legendBody.style.display !== 'none';
    legendBody.style.display = isOpen ? 'none' : 'block';
    legendCaret.style.transform = isOpen ? 'rotate(0deg)' : 'rotate(180deg)';
  });

  bindDateField('epi-start');
  bindDateField('epi-end');

  document.getElementById('epi-fetch').addEventListener('click', runEpicenterFetch);

  // 既に共有データが取得済みなら、通信なしで自動的に表示する
  if (sharedDateRange.rawFeatures) {
    runEpicenterFetch();
  }
}

async function runEpicenterFetch() {
  const startStr = document.getElementById('epi-start').value;
  const endStr = document.getElementById('epi-end').value;
  const statusEl = document.getElementById('epi-status');
  const btn = document.getElementById('epi-fetch');
  if (!startStr || !endStr) { toast('開始日・終了日を指定してください'); return; }

  const dates = dateRange(startStr, endStr);
  if (dates.length === 0) { toast('日付範囲が不正です'); return; }
  if (dates.length > 62) { toast('一度に取得できるのは最大62日分です'); return; }

  epicenterState.startDate = startStr;
  epicenterState.endDate = endStr;

  // 直前にb値解析タブなどで同一期間を取得済みなら、フェッチせず共有データをそのまま使う
  if (sharedDateRange.rawFeatures && sharedDateRange.startDate === startStr && sharedDateRange.endDate === endStr) {
    applySharedFeatures(sharedDateRange.rawFeatures);
    statusEl.textContent = `${sharedDateRange.rawFeatures.length}件（共有データから即時反映）`;
    return;
  }

  // すでに（b値解析タブなどで）全期間がキャッシュ済みなら、通信を行わず即座に反映する
  if (isRangeFullyCached(dates)) {
    const { features, errors } = buildFromCache(dates);
    sharedDateRange.startDate = startStr;
    sharedDateRange.endDate = endStr;
    sharedDateRange.rawFeatures = features;
    applySharedFeatures(features);
    statusEl.textContent = `${features.length}件（キャッシュから即時反映）${errors.length ? `／${errors.length}日分は取得失敗` : ''}`;
    return;
  }

  btn.disabled = true;
  statusEl.innerHTML = `<span class="spinner"></span> 取得中 0 / ${dates.length}`;

  const { features, errors, cacheHits } = await fetchHypoRange(dates, (done, total, errs, hits) => {
    statusEl.innerHTML = `<span class="spinner"></span> 取得中 ${done} / ${total}${hits ? `（キャッシュ ${hits}件）` : ''}`;
  });

  btn.disabled = false;
  sharedDateRange.startDate = startStr;
  sharedDateRange.endDate = endStr;
  sharedDateRange.rawFeatures = features;
  applySharedFeatures(features);

  if (errors.length > 0) {
    statusEl.textContent = `${features.length}件取得（${errors.length}日分は取得失敗）`;
    console.warn('hypo fetch errors:', errors);
    if (errors.length === dates.length) {
      toast('CORSまたはネットワークエラーによりデータを取得できませんでした。ブラウザのコンソールを確認してください。');
    }
  } else {
    statusEl.textContent = `${features.length}件取得完了${cacheHits ? `（うちキャッシュ ${cacheHits}日分）` : ''}`;
  }
}

/* =========================================================
   VIEW 2: b値解析 (Aki's Maximum Likelihood Method)
   レイヤーは initSharedMap() 内で震央分布レイヤーと同時にセットアップ済み。
   ========================================================= */
let bvalueState = {
  data: [],
  startDate: null,
  endDate: null,
  bbox: null, // [minLon, minLat, maxLon, maxLat]
  drawing: false,
  drawStart: null
};

// 2点クリック方式での矩形領域選択
// 1回目のクリックで始点を確定し、2回目のクリックで矩形を確定・描画する（プレビュー描画は行わない）
function setupBboxDrawing() {
  let startLngLat = null;

  function bboxPolygon(a, b) {
    const minLon = Math.min(a.lng, b.lng), maxLon = Math.max(a.lng, b.lng);
    const minLat = Math.min(a.lat, b.lat), maxLat = Math.max(a.lat, b.lat);
    return {
      bbox: [minLon, minLat, maxLon, maxLat],
      geojson: {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [[[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]]]
          },
          properties: {}
        }]
      }
    };
  }

  function finishDrawing() {
    startLngLat = null;
    bvalueState.drawing = false;
    const btn = document.getElementById('bv-draw-btn');
    if (btn) { btn.classList.remove('btn-accent'); btn.textContent = '領域を選択'; }
    sharedMap.getCanvas().style.cursor = '';
  }

  function onClick(e) {
    if (!bvalueState.drawing) return;
    if (!startLngLat) {
      // 1回目のクリック: 始点を確定（描画はまだ行わない）
      startLngLat = e.lngLat;
      const btn = document.getElementById('bv-draw-btn');
      if (btn) btn.textContent = '2点目クリック';
    } else {
      // 2回目のクリック: 矩形を確定し、このタイミングで初めて描画する
      const { bbox, geojson } = bboxPolygon(startLngLat, e.lngLat);
      sharedMap.getSource('bv-bbox').setData(geojson);
      bvalueState.bbox = bbox;
      finishDrawing();
      updateBboxLabel();
      computeAndRenderBvalue();
    }
  }

  sharedMap.on('click', onClick);

  // 外部（ボタン等）から描画モードの開始/中断を扱えるようにする
  bvalueState._cancelDrawing = () => { finishDrawing(); };
  bvalueState._onDrawModeChanged = (isDrawing) => {
    if (!isDrawing) finishDrawing();
    else sharedMap.getCanvas().style.cursor = 'crosshair';
  };
}

function updateBboxLabel() {
  const el = document.getElementById('bv-bbox-label');
  if (!el) return;
  if (!bvalueState.bbox) { el.textContent = '未選択（全域）'; return; }
  const [minLon, minLat, maxLon, maxLat] = bvalueState.bbox;
  el.textContent = `${minLat.toFixed(2)}〜${maxLat.toFixed(2)}°N, ${minLon.toFixed(2)}〜${maxLon.toFixed(2)}°E`;
}

function buildBvaluePanel() {
  const container = document.getElementById('view-bvalue');

  const panel = document.createElement('div');
  panel.className = 'floating-panel glass-panel';
  panel.style.cssText = 'top:16px; left:16px; width:250px;';
  const initStart = sharedDateRange.startDate || defaultDateStr(-7);
  const initEnd = sharedDateRange.endDate || defaultDateStr(0);
  panel.innerHTML = `
    <div class="panel-title"><span class="bar"></span>b値解析 — データ範囲</div>
    <label class="field-label">開始日</label>
    ${createDateFieldHTML('bv-start', initStart)}
    <div style="height:8px;"></div>
    <label class="field-label">終了日</label>
    ${createDateFieldHTML('bv-end', initEnd)}
    <div style="height:12px;"></div>
    <button class="btn btn-accent" id="bv-fetch" style="width:100%;">データ取得</button>
    <div style="height:10px;"></div>
    <div class="status-text" id="bv-status">待機中</div>
    <div class="divider"></div>
    <label class="field-label">解析対象領域</label>
    <div class="row">
      <button class="btn btn-sm" id="bv-draw-btn">領域を選択</button>
      <button class="btn btn-sm" id="bv-clear-btn">クリア</button>
    </div>
    <div style="height:6px;"></div>
    <div class="status-text font-num" id="bv-bbox-label" style="font-family:var(--font-base);">未選択（全域）</div>
  `;
  container.appendChild(panel);

  const resultPanel = document.createElement('div');
  resultPanel.className = 'floating-panel glass-panel';
  resultPanel.style.cssText = 'top:16px; right:16px; width:270px;';
  resultPanel.innerHTML = `
    <div class="panel-title"><span class="bar"></span>b値 — Aki's MLE</div>
    <div style="height:10px;"></div>
    <label class="field-label">Mc（マグニチュード完全性閾値）</label>
    <div class="row">
      <select id="bv-mc-mode" style="flex:1.2;">
        <option value="auto">自動推定（最大曲率法）</option>
        <option value="manual">手動指定</option>
      </select>
      <input type="number" id="bv-mc-manual" step="0.1" value="2.0" style="display:none; width:70px;">
    </div>
    <div style="height:14px;"></div>
    <div id="bv-result" class="font-num" style="font-family:var(--font-base); font-size:12.5px; line-height:1.9; color:var(--text-1);">
      データを取得してください
    </div>
  `;
  container.appendChild(resultPanel);

  bindDateField('bv-start');
  bindDateField('bv-end');

  document.getElementById('bv-fetch').addEventListener('click', runBvalueFetch);
  document.getElementById('bv-draw-btn').addEventListener('click', () => {
    bvalueState.drawing = !bvalueState.drawing;
    const btn = document.getElementById('bv-draw-btn');
    btn.classList.toggle('btn-accent', bvalueState.drawing);
    btn.textContent = bvalueState.drawing ? '1点目クリック' : '領域を選択';
    if (bvalueState._onDrawModeChanged) bvalueState._onDrawModeChanged(bvalueState.drawing);
  });
  // Escキーで選択中の矩形描画をキャンセル
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && bvalueState.drawing && bvalueState._cancelDrawing) {
      bvalueState._cancelDrawing();
    }
  });
  document.getElementById('bv-clear-btn').addEventListener('click', () => {
    bvalueState.bbox = null;
    sharedMap.getSource('bv-bbox').setData({ type: 'FeatureCollection', features: [] });
    updateBboxLabel();
    computeAndRenderBvalue();
  });
  document.getElementById('bv-mc-mode').addEventListener('change', (e) => {
    document.getElementById('bv-mc-manual').style.display = e.target.value === 'manual' ? 'block' : 'none';
    computeAndRenderBvalue();
  });
  document.getElementById('bv-mc-manual').addEventListener('input', computeAndRenderBvalue);

  // 既に共有データが取得済みなら、通信なしで自動的に表示する
  if (sharedDateRange.rawFeatures) {
    runBvalueFetch();
  }
}

async function runBvalueFetch() {
  const startStr = document.getElementById('bv-start').value;
  const endStr = document.getElementById('bv-end').value;
  const statusEl = document.getElementById('bv-status');
  const btn = document.getElementById('bv-fetch');
  if (!startStr || !endStr) { toast('開始日・終了日を指定してください'); return; }

  const dates = dateRange(startStr, endStr);
  if (dates.length === 0) { toast('日付範囲が不正です'); return; }
  if (dates.length > 92) { toast('一度に取得できるのは最大92日分です'); return; }

  bvalueState.startDate = startStr;
  bvalueState.endDate = endStr;

  // 直前に震央分布タブなどで同一期間を取得済みなら、フェッチせず共有データをそのまま使う
  if (sharedDateRange.rawFeatures && sharedDateRange.startDate === startStr && sharedDateRange.endDate === endStr) {
    applySharedFeatures(sharedDateRange.rawFeatures);
    statusEl.textContent = `${bvalueState.data.length}件（共有データから即時反映）`;
    return;
  }

  // すでに（震央分布タブなどで）全期間がキャッシュ済みなら、通信を行わず即座に反映する
  if (isRangeFullyCached(dates)) {
    const { features, errors } = buildFromCache(dates);
    sharedDateRange.startDate = startStr;
    sharedDateRange.endDate = endStr;
    sharedDateRange.rawFeatures = features;
    applySharedFeatures(features);
    statusEl.textContent = `${bvalueState.data.length}件（キャッシュから即時反映）${errors.length ? `／${errors.length}日分は取得失敗` : ''}`;
    return;
  }

  btn.disabled = true;
  statusEl.innerHTML = `<span class="spinner"></span> 取得中 0 / ${dates.length}`;

  const { features, errors, cacheHits } = await fetchHypoRange(dates, (done, total, errs, hits) => {
    statusEl.innerHTML = `<span class="spinner"></span> 取得中 ${done} / ${total}${hits ? `（キャッシュ ${hits}件）` : ''}`;
  });

  btn.disabled = false;
  sharedDateRange.startDate = startStr;
  sharedDateRange.endDate = endStr;
  sharedDateRange.rawFeatures = features;
  applySharedFeatures(features);

  if (errors.length > 0) {
    statusEl.textContent = `${bvalueState.data.length}件取得（${errors.length}日分失敗）`;
    if (errors.length === dates.length) {
      toast('CORSまたはネットワークエラーによりデータを取得できませんでした。ブラウザのコンソールを確認してください。');
    }
  } else {
    statusEl.textContent = `${bvalueState.data.length}件取得完了${cacheHits ? `（うちキャッシュ ${cacheHits}日分）` : ''}`;
  }
}

function pointInBbox(lon, lat, bbox) {
  if (!bbox) return true;
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
}

// 最大曲率法による Mc 自動推定
function estimateMcMaxCurvature(mags, binWidth = 0.1) {
  if (mags.length === 0) return null;
  const rounded = mags.map(m => Math.round(m / binWidth) * binWidth);
  const counts = new Map();
  rounded.forEach(m => counts.set(m, (counts.get(m) || 0) + 1));
  let bestM = null, bestCount = -1;
  for (const [m, c] of counts.entries()) {
    if (c > bestCount) { bestCount = c; bestM = m; }
  }
  return bestM;
}

// Aki (1965) 最尤推定法: b = log10(e) / (mean(M) - (Mc - binWidth/2))
function computeBvalueAki(mags, mc, binWidth = 0.1) {
  const sample = mags.filter(m => m >= mc - 1e-9);
  const n = sample.length;
  if (n < 2) return { b: null, n, stdErr: null };
  const meanM = sample.reduce((a, b) => a + b, 0) / n;
  const b = Math.LOG10E / (meanM - (mc - binWidth / 2));
  // Shi & Bolt (1982) 標準誤差
  const variance = sample.reduce((acc, m) => acc + Math.pow(m - meanM, 2), 0) / (n * (n - 1));
  const stdErr = 2.30 * Math.sqrt(variance) * b * b;
  return { b, n, stdErr, meanM };
}

function computeAndRenderBvalue() {
  const resultEl = document.getElementById('bv-result');
  if (!resultEl) return;

  const filtered = bvalueState.data.filter(f => pointInBbox(f.lon, f.lat, bvalueState.bbox));
  const mags = filtered.map(f => f.mag).filter(m => m != null);

  if (mags.length < 5) {
    resultEl.innerHTML = `対象地震数: ${mags.length}<br><span style="color:var(--text-2);">解析には最低5件以上必要です</span>`;
    return;
  }

  const mcMode = document.getElementById('bv-mc-mode').value;
  let mc;
  if (mcMode === 'manual') {
    mc = parseFloat(document.getElementById('bv-mc-manual').value) || 2.0;
  } else {
    mc = estimateMcMaxCurvature(mags);
  }

  const { b, n, stdErr, meanM } = computeBvalueAki(mags, mc);

  if (b == null) {
    resultEl.innerHTML = `Mc以上のデータが不足しています（Mc=${mc.toFixed(1)}）`;
    return;
  }

  const aValue = Math.log10(n) + b * mc; // a値（GR則: log10(N) = a - b*M, N=Mc以上の総数として近似）

  resultEl.innerHTML = `
    <div class="font-num" style="font-size:26px; font-weight:800; color:var(--accent); font-family:var(--font-base);">
      b = ${b.toFixed(3)} <span style="font-size:13px; color:var(--text-2); font-weight:400;">± ${stdErr.toFixed(3)}</span>
    </div>
    <div class="divider" style="margin:8px 0;"></div>
    総地震数（全域）: ${mags.length}<br>
    Mc（完全性閾値）: ${mc.toFixed(1)}<br>
    解析対象数（M≥Mc）: ${n}<br>
    平均M: ${meanM.toFixed(2)}<br>
    a値（推定）: ${aValue.toFixed(2)}
  `;
}

/* =========================================================
   VIEW 3: 震源球 (Focal Mechanism)
   top.html の一覧をパースして直近イベントを表示
   ========================================================= */

// CORS対応の読み取り専用プロキシ経由でJMAページのHTMLを取得
// (JMAサイト自体はCORSヘッダを返さないため、r.jina.aiのテキスト化プロキシを利用)
function mechProxyUrl(targetUrl) {
  return `https://r.jina.ai/${targetUrl}`;
}

async function fetchMechList() {
  const target = 'https://www.data.jma.go.jp/eew/data/mech/top.html';
  const res = await fetch(mechProxyUrl(target));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  return parseMechListText(text);
}

// Markdownテーブルの1行 "| a | b | c |" をセル配列に分解する共通ヘルパー
function splitMdRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}

function parseMdLink(cell) {
  // "[詳細](url "title")" 形式からラベルとURLを抽出。リンクが無ければ null。
  const m = /\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/.exec(cell);
  if (!m) return null;
  return { label: m[1], url: m[2] };
}

// r.jina.ai はページをMarkdown風テキストに変換して返す。
// JMAの発震機構解一覧テーブルは「発生時刻 | 震源位置(緯度/経度/深さの3列) | M | 震央地域名 | 初動解 | CMT国内 | CMT全世界」
// というヘッダー2段構成のため、時刻セルを含む行と、その次に来る「緯度|経度|深さ」だけの行をペアで読む。
function parseMechListText(text) {
  const lines = text.split('\n');
  const rows = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('|') || !/\d{4}年\d{2}月\d{2}日\d{2}時\d{2}分頃/.test(line)) continue;

    const cells = splitMdRow(line);
    // 期待するセル数は9（時刻, 緯度, 経度, 深さ, M, 地域名, 初動解, CMT国内, CMT全世界）
    // ただし表によっては緯度・経度・深さが結合されていたり別行の場合があるため、柔軟に判定する
    if (cells.length < 6) continue;

    const timeMatch = /(\d{4}年\d{2}月\d{2}日\d{2}時\d{2}分頃)/.exec(cells[0]);
    if (!timeMatch) continue;
    const timeStr = timeMatch[1];

    // 緯度・経度・深さ・M・地域名・リンク3列の位置をラベルで探索する
    let lat = null, lon = null, depth = null, mag = null, place = null;
    const links = [];
    for (const c of cells.slice(1)) {
      const latM = /北緯([\d.]+)度/.exec(c);
      const lonM = /東経([\d.]+)度/.exec(c);
      const depM = depth == null && /^(約?[\d.]+\s*km|ごく浅い)$/.exec(c);
      if (latM) { lat = parseFloat(latM[1]); continue; }
      if (lonM) { lon = parseFloat(lonM[1]); continue; }
      if (depM) { depth = c; continue; }
      const link = parseMdLink(c);
      if (link) { links.push(link); continue; }
      if (c === '-') { links.push(null); continue; }
      if (/^[\d.]+$/.test(c) && mag == null) { mag = parseFloat(c); continue; }
      if (c && place == null && !/^[\d.]+$/.test(c)) { place = c; continue; }
    }

    if (lat == null || lon == null || mag == null) continue;

    rows.push({
      timeStr,
      lat, lon,
      depth: depth || '不明',
      mag,
      place: place || '不明',
      initial: links[0] || null,
      cmtDomestic: links[1] || null,
      cmtWorld: links[2] || null
    });
  }
  return rows;
}

function mechFigImageUrl(figHtmlUrl) {
  // .html -> .png の単純置換（既知のJMA命名規則）
  return figHtmlUrl.replace(/\.html$/, '.png');
}

// JMAの震源球pngは、常に画像中央に円形の震源球が描かれ、その周囲に
// 白背景の余白がある構図で共通している。Canvasでのピクセル走査による
// 自動検出は、クロスオリジン制約（CORS）で読み取り自体が失敗することが多く、
// また円形図形に対する矩形バウンディングボックス検出では四隅の余白を
// 除去しきれず不安定だったため、より単純で確実な「中央基準の固定率クロップ」
// 方式に統一する。画像を中央から一定割合だけ拡大し、はみ出た部分は
// 親要素のoverflow:hiddenでクロップする。
function fitMechImage(img) {
  // JMAの画像ファイル名プレフィックス（mc=初動解, cmt=CMT解国内, world=CMT解全世界）ごとに
  // 余白の量が経験的に異なるため、種別に応じた拡大率を適用する。
  const src = img.currentSrc || img.src || '';
  const fname = src.split('/').pop() || '';
  let scale = 1.3;
  if (/^mc/.test(fname)) scale = 1.55;         // 初動解: 観測点プロットの分だけ外側に余白が多い
  else if (/^cmt/.test(fname)) scale = 1.15;   // CMT解(国内): 元々余白が少ない
  else if (/^world/.test(fname)) scale = 1.3;  // CMT解(全世界)

  img.style.width = '100%';
  img.style.height = '100%';
  img.style.maxWidth = '100%';
  img.style.maxHeight = '100%';
  img.style.objectFit = 'contain';
  img.style.transform = `scale(${scale})`;
}

function mechImageFallback(img) {
  const parent = img.parentElement;
  if (parent) {
    parent.innerHTML = '<span style="color:var(--text-2); font-size:11px; padding:10px; text-align:center;">画像取得不可</span>';
  }
}

// 発震機構解 個別詳細ページ（初動解 or CMT解）をパースし、
// 断層パラメータ（走向・傾斜・すべり角）、P/T/N軸、観測点数・V.R.などを抽出する
async function fetchMechDetail(url) {
  const res = await fetch(mechProxyUrl(url));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  return parseMechDetailText(text, url);
}

// 発震機構解 個別詳細ページ（初動解 or CMT解）をパースする。
// JMAのページ構造（r.jina.aiでMarkdown化した場合）は以下のテーブルで構成される:
//   1. 発生時刻と震源位置およびマグニチュード
//   2. （CMT解のみ）セントロイド時刻とセントロイド位置およびモーメントマグニチュード(Mw)
//   3. 震源球画像
//   4. （CMT解のみ）モーメントテンソル解: Mo, Mrr, Mtt, Mff, Mrt, Mrf, Mtf, 指数, 単位, 非D.C.成分比
//   5. 発震機構解: 断層面解１（走向/傾斜/すべり角 + Ｐ軸/Ｔ軸/Ｎ軸の方位）
//                 断層面解２（同上、次の行は各軸の「傾斜」）
//   6. 使用観測点数と解の精度: 観測点数, V.R.
function parseMechDetailText(text, sourceUrl) {
  const lines = text.split('\n');
  const detail = {
    imageUrl: null,
    planes: null,        // [{label, strike, dip, rake}, ...]
    axes: null,           // {p:{azimuth,plunge}, t:{...}, n:{...}}
    stations: null,
    vr: null,
    centroid: null,       // {timeStr, lat, lon, depth, mw}
    moment: null          // {mo, exponent, unit, mrr, mtt, mff, mrt, mrf, mtf, nonDc}
  };

  let axesAzimuth = null; // 断層面解１の行から拾う Ｐ/Ｔ/Ｎ軸「方位」
  let axesPlunge = null;  // 断層面解２の行から拾う Ｐ/Ｔ/Ｎ軸「傾斜」

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 震源球画像: ![...](....png)
    const imgM = /!\[[^\]]*\]\((https?:\/\/[^\s)]+\.png)\)/.exec(line);
    if (imgM && !detail.imageUrl) detail.imageUrl = imgM[1];

    if (!line.includes('|')) continue;
    const cells = splitMdRow(line);

    // セントロイド行: "2026年06月25日07時30分20.0秒 | 北緯40度13.7分 | 東経142度20.6分 | 50km | 6.9"
    // ヘッダーの次に来る、緯度/経度に「分」を含むデータ行で識別する
    if (!detail.centroid) {
      const timeM = /^(\d{4}年\d{2}月\d{2}日\d{2}時\d{2}分[\d.]+秒)$/.exec((cells[0] || '').trim());
      const latM = /北緯([\d.]+)度([\d.]+)分/.exec(cells[1] || '');
      const lonM = /東経([\d.]+)度([\d.]+)分/.exec(cells[2] || '');
      if (timeM && latM && lonM) {
        detail.centroid = {
          timeStr: timeM[1],
          lat: (parseFloat(latM[1]) + parseFloat(latM[2]) / 60).toFixed(3),
          lon: (parseFloat(lonM[1]) + parseFloat(lonM[2]) / 60).toFixed(3),
          depth: (cells[3] || '').trim(),
          mw: (cells[4] || '').trim()
        };
        continue;
      }
    }

    // モーメントテンソル解の行: "2.4 | 1.54 | 0.12 | -1.66 | 0.85 | 1.53 | -0.36 | 19 | ×10(指数) Nm | -0.04"
    // 直前行がヘッダー "Mo | Mrr | Mtt | ..." であることで識別する
    if (!detail.moment) {
      const prevCells = i > 0 && lines[i - 1].includes('|') ? splitMdRow(lines[i - 1]) : null;
      const isMomentHeader = prevCells && prevCells[0] === 'Mo' && prevCells[1] === 'Mrr';
      if (isMomentHeader && cells.length >= 10 && /^-?[\d.]+$/.test(cells[0])) {
        detail.moment = {
          mo: cells[0], mrr: cells[1], mtt: cells[2], mff: cells[3],
          mrt: cells[4], mrf: cells[5], mtf: cells[6],
          exponent: cells[7], unit: cells[8], nonDc: cells[9]
        };
        continue;
      }
    }

    // 断層面解の行: "断層面解１ | 24 | 69 | 101 | 方位 | 106 | 312 | 200"
    //             "断層面解２ | 177 | 24 | 64  | 傾斜 | 23  | 65  | 10"
    if (cells[0] && cells[0].includes('断層面解')) {
      if (!detail.planes) detail.planes = [];
      detail.planes.push({
        label: cells[0],
        strike: cells[1], dip: cells[2], rake: cells[3]
      });
      if (cells.length >= 8) {
        if (cells[4] === '方位') {
          axesAzimuth = { p: cells[5], t: cells[6], n: cells[7] };
        } else if (cells[4] === '傾斜') {
          axesPlunge = { p: cells[5], t: cells[6], n: cells[7] };
        }
      }
    }

    // 観測点数・V.R.（CMT解）または スコア（初動解）の行:
    // "観測点数 | 25点 | V.R. | 76%"  /  "観測点数 | 229点 | スコア | 94%"
    if (cells.some(c => c.includes('観測点数'))) {
      const idx = cells.findIndex(c => c.includes('観測点数'));
      if (idx >= 0 && cells[idx + 1]) detail.stations = cells[idx + 1];
      const scoreIdx = cells.findIndex(c => c.includes('V.R.') || c === 'スコア');
      if (scoreIdx >= 0 && cells[scoreIdx + 1]) {
        detail.vr = cells[scoreIdx + 1];
        detail.vrLabel = cells[scoreIdx]; // "V.R." または "スコア"
      }
    }
  }

  if (axesAzimuth || axesPlunge) {
    detail.axes = {
      p: { azimuth: axesAzimuth ? axesAzimuth.p : null, plunge: axesPlunge ? axesPlunge.p : null },
      t: { azimuth: axesAzimuth ? axesAzimuth.t : null, plunge: axesPlunge ? axesPlunge.t : null },
      n: { azimuth: axesAzimuth ? axesAzimuth.n : null, plunge: axesPlunge ? axesPlunge.n : null }
    };
  }

  if (!detail.imageUrl) {
    // 画像リンクが見つからない場合はURL命名規則からフォールバック
    detail.imageUrl = mechFigImageUrl(sourceUrl);
  }
  return detail;
}

// mechState: 取得済みの一覧データと現在選択中のインデックス、
// 各詳細URLごとの取得結果キャッシュ（初動解/CMT国内/CMT全世界を切替可能にする）を保持する
const mechState = {
  rows: [],
  selectedIdx: null,
  detailCache: new Map() // url -> detail object
};

function renderMechList() {
  const listEl = document.getElementById('mech-list');
  if (!listEl) return;
  listEl.innerHTML = mechState.rows.map((r, i) => {
    return `
      <div class="mech-item${mechState.selectedIdx === i ? ' selected' : ''}" data-idx="${i}" style="
        padding:12px 10px; margin-top:10px; border-radius:12px;
        background:rgba(255,255,255,0.04); border:1px solid var(--glass-border);
      ">
        <div style="display:flex; justify-content:space-between; align-items:baseline;">
          <div style="font-weight:700; font-size:13.5px;">${r.place}</div>
          <div class="font-num" style="font-family:var(--font-base); font-size:13px; color:var(--accent);">M${r.mag.toFixed(1)}</div>
        </div>
        <div class="font-num" style="font-size:11.5px; color:var(--text-2); margin-top:2px; font-family:var(--font-base);">
          ${r.timeStr} / 北緯${r.lat}° 東経${r.lon}° / 深さ${r.depth}
        </div>
      </div>
    `;
  }).join('');

  listEl.querySelectorAll('.mech-item').forEach(el => {
    el.addEventListener('click', () => {
      const idx = Number(el.dataset.idx);
      selectMechItem(idx);
    });
  });
}

function selectMechItem(idx) {
  mechState.selectedIdx = idx;
  renderMechList();
  renderMechDetailPanel(idx);
}

// 右カラムに、選択されたイベントの解法リンク（初動解/CMT国内/CMT全世界）タブと
// 詳細（震源球画像・断層パラメータ）を描画する
function renderMechDetailPanel(idx) {
  const detailCol = document.getElementById('mech-detail-col');
  if (!detailCol) return;
  const r = mechState.rows[idx];
  if (!r) return;

  const links = [];
  if (r.initial && r.initial.url) links.push({ type: '初動解', ...r.initial });
  if (r.cmtDomestic && r.cmtDomestic.url) links.push({ type: 'CMT解(国内)', ...r.cmtDomestic });
  if (r.cmtWorld && r.cmtWorld.url) links.push({ type: 'CMT解(全世界)', ...r.cmtWorld });

  detailCol.innerHTML = `
    <div class="glass-panel" style="padding:18px;">
      <div style="display:flex; justify-content:space-between; align-items:baseline; gap:10px; flex-wrap:wrap;">
        <div style="font-weight:700; font-size:15px;">${r.place}</div>
        <div class="font-num" style="font-family:var(--font-base); font-size:14px; color:var(--accent);">M${r.mag.toFixed(1)}</div>
      </div>
      <div class="font-num" style="font-size:11.5px; color:var(--text-2); margin-top:3px; font-family:var(--font-base);">
        ${r.timeStr} / 北緯${r.lat}° 東経${r.lon}° / 深さ${r.depth}
      </div>
      <div class="divider"></div>
      ${links.length ? `
        <div style="display:flex; gap:6px; flex-wrap:wrap;" id="mech-tab-row"></div>
        <div id="mech-detail-body" style="margin-top:12px;"></div>
      ` : `<div class="mech-detail-placeholder">この地震の発震機構解はまだ公開されていません</div>`}
    </div>
  `;

  if (!links.length) return;

  const tabRow = document.getElementById('mech-tab-row');
  tabRow.innerHTML = links.map((l, i) =>
    `<span class="mech-tab btn btn-sm${i === 0 ? ' btn-accent' : ''}" data-url="${encodeURIComponent(l.url)}" data-label="${l.type}">${l.type}: ${l.label}</span>`
  ).join('');

  tabRow.querySelectorAll('.mech-tab').forEach(el => {
    el.addEventListener('click', () => {
      tabRow.querySelectorAll('.mech-tab').forEach(t => t.classList.remove('btn-accent'));
      el.classList.add('btn-accent');
      const url = decodeURIComponent(el.dataset.url);
      const label = el.dataset.label;
      loadMechDetailBody(url, label);
    });
  });

  // 初期表示は先頭のタブ（初動解優先）を自動で読み込む
  loadMechDetailBody(links[0].url, links[0].type);
}

async function loadMechDetailBody(url, label) {
  const bodyEl = document.getElementById('mech-detail-body');
  if (!bodyEl) return;
  bodyEl.innerHTML = `<div class="status-text"><span class="spinner"></span> ${label}を読み込み中...</div>`;
  try {
    let detail = mechState.detailCache.get(url);
    if (!detail) {
      detail = await fetchMechDetail(url);
      mechState.detailCache.set(url, detail);
    }
    const plane = (detail.planes && detail.planes[0]) || null;
    const plane2 = (detail.planes && detail.planes[1]) || null;
    const axes = detail.axes;
    const moment = detail.moment;
    const centroid = detail.centroid;

    bodyEl.innerHTML = `
      <div style="display:flex; gap:16px; flex-wrap:wrap; align-items:flex-start;">
        <div style="
          flex:0 0 auto;
          background:#000; border-radius:10px; overflow:hidden;
          display:flex; justify-content:center; align-items:center;
          width:180px; height:180px;
          border:1px solid var(--glass-border);
        ">
          <img src="${detail.imageUrl}" alt="震源球" style="
            max-width:100%; max-height:100%; width:auto; height:auto; object-fit:contain;
            mix-blend-mode:screen; filter:brightness(1.05);
          " onload="fitMechImage(this)" onerror="mechImageFallback(this)">
        </div>
        <div style="flex:1 1 240px; min-width:200px;">
          ${centroid ? `
          <div style="font-size:10.5px; color:var(--text-2); letter-spacing:0.06em; margin-bottom:4px;">セントロイド（Mw）</div>
          <div class="font-num" style="font-family:var(--font-base); font-size:11.5px; color:var(--text-1); line-height:1.7;">
            ${centroid.timeStr}<br>
            北緯${centroid.lat}° 東経${centroid.lon}° / 深さ${centroid.depth}<br>
            <span style="color:var(--accent); font-weight:700; font-size:13px;">Mw ${centroid.mw}</span>
          </div>
          <div class="divider" style="margin:8px 0;"></div>
          ` : ''}
          ${plane ? `
          <div style="font-size:10.5px; color:var(--text-2); letter-spacing:0.06em; margin-bottom:4px;">断層パラメータ（走向 / 傾斜 / すべり角）</div>
          <div class="font-num" style="font-family:var(--font-base); font-size:11.5px; color:var(--text-1); line-height:1.8;">
            断層面解１： ${plane.strike}° / ${plane.dip}° / ${plane.rake}°<br>
            ${plane2 ? `断層面解２： ${plane2.strike}° / ${plane2.dip}° / ${plane2.rake}°<br>` : ''}
            ${detail.stations ? `観測点数： ${detail.stations}` : ''}${detail.vr ? ` ／ ${detail.vrLabel || 'V.R.'}： ${detail.vr}` : ''}
          </div>` : `<div style="font-size:11.5px; color:var(--text-2);">断層パラメータを解析できませんでした</div>`}
        </div>
      </div>

      ${axes ? `
      <div class="divider"></div>
      <div style="font-size:10.5px; color:var(--text-2); letter-spacing:0.06em; margin-bottom:6px;">主応力軸（方位 / 傾斜）</div>
      <div class="font-num" style="font-family:var(--font-base); font-size:11.5px; color:var(--text-1); line-height:1.9; display:grid; grid-template-columns:auto 1fr; column-gap:14px; max-width:280px;">
        <span style="color:var(--accent-2);">Ｐ軸（圧力軸）</span><span>${axes.p.azimuth ?? '—'}° / ${axes.p.plunge ?? '—'}°</span>
        <span style="color:var(--accent-mag);">Ｔ軸（張力軸）</span><span>${axes.t.azimuth ?? '—'}° / ${axes.t.plunge ?? '—'}°</span>
        <span style="color:var(--text-1);">Ｎ軸（中立軸）</span><span>${axes.n.azimuth ?? '—'}° / ${axes.n.plunge ?? '—'}°</span>
      </div>` : ''}

      ${moment ? `
      <div class="divider"></div>
      <div style="font-size:10.5px; color:var(--text-2); letter-spacing:0.06em; margin-bottom:6px;">モーメントテンソル解</div>
      <div class="font-num" style="font-family:var(--font-base); font-size:11.5px; color:var(--text-1); line-height:1.7;">
        Mo： ${moment.mo} × 10<sup>${moment.exponent}</sup> ${moment.unit.replace(/^×10\(指数\)\s*/, '')} ／ 非D.C.成分比： ${moment.nonDc}
      </div>
      <div class="font-num" style="font-family:var(--font-base); font-size:10.5px; color:var(--text-2); line-height:1.8; margin-top:6px; display:grid; grid-template-columns:repeat(3, auto); gap:2px 16px;">
        <span>Mrr = ${moment.mrr}</span><span>Mtt = ${moment.mtt}</span><span>Mff = ${moment.mff}</span>
        <span>Mrt = ${moment.mrt}</span><span>Mrf = ${moment.mrf}</span><span>Mtf = ${moment.mtf}</span>
      </div>` : ''}

      <div style="margin-top:12px; text-align:center;">
        <a href="${url}" target="_blank" rel="noopener" class="btn btn-sm" style="text-decoration:none;">気象庁ページで詳細を見る ↗</a>
      </div>
    `;
  } catch (e) {
    console.error(e);
    bodyEl.innerHTML = `
      <span style="color:var(--danger); font-size:12px;">詳細の取得に失敗しました: ${e.message}</span>
      <div style="margin-top:8px; text-align:center;">
        <a href="${url}" target="_blank" rel="noopener" class="btn btn-sm" style="text-decoration:none;">気象庁ページで直接見る ↗</a>
      </div>
    `;
  }
}

async function initMechView() {
  const scroll = document.getElementById('mech-scroll');
  scroll.innerHTML = `
    <div class="mech-layout">
      <div class="mech-list-col">
        <div class="glass-panel" style="padding:18px;">
          <div class="panel-title"><span class="bar"></span>震源球 — 主な地震の発震機構解（速報値・直近5日間）</div>
          <div class="status-text" id="mech-status"><span class="spinner"></span> 気象庁データを取得中...</div>
          <div id="mech-list"></div>
        </div>
      </div>
      <div class="mech-detail-col" id="mech-detail-col">
        <div class="glass-panel" style="min-height:100%;">
          <div class="mech-detail-placeholder">左のリストからイベントを選択してください</div>
        </div>
      </div>
    </div>
  `;

  try {
    const rows = await fetchMechList();
    const statusEl = document.getElementById('mech-status');

    if (rows.length === 0) {
      statusEl.innerHTML = `<span style="color:var(--danger);">データを解析できませんでした（ページ構造が変更された可能性があります）</span>
        <div style="margin-top:8px;"><a href="https://www.data.jma.go.jp/eew/data/mech/top.html" target="_blank" rel="noopener" class="btn btn-sm" style="text-decoration:none;">気象庁ページを直接開く ↗</a></div>`;
      return;
    }

    statusEl.textContent = `${rows.length}件のイベントを取得`;
    mechState.rows = rows;
    renderMechList();

  } catch (e) {
    console.error(e);
    document.getElementById('mech-status').innerHTML =
      `<span style="color:var(--danger);">取得失敗: ${e.message}。CORSプロキシ経由での取得が拒否された可能性があります。</span>
      <div style="margin-top:8px;"><a href="https://www.data.jma.go.jp/eew/data/mech/top.html" target="_blank" rel="noopener" class="btn btn-sm" style="text-decoration:none;">気象庁ページを直接開く ↗</a></div>`;
  }
}

/* ---------------------------------------------------------
   初期化
   3つのビューをすべて起動時に初期化しておく（タブ切替時の再構築を防ぐため）。
   地図は共有の1インスタンスのみを生成し、震央分布・b値解析の両パネルを
   その load ハンドラ内でセットアップする。地図要素自体は #app 直下に
   固定済みで、タブ切替時も一切移動させない。
--------------------------------------------------------- */
loadEpinameData(); // 震央地名データを先読み開始（完了は待たず、使用時にawaitする）
initSharedMap();
initMechView();
