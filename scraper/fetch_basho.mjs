// ============================================================
// トト相撲 データ取得スクリプト（GitHub Actions用）
// スポーツナビの取組ページから幕内の取組・結果を取得し
// data/basho.json に保存する。依存パッケージなし（Node 20+）。
//
// 使い方:  node scraper/fetch_basho.mjs
// ============================================================
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";

const OUT = "data/basho.json";
const BASE = "https://sports.yahoo.co.jp/sumo/torikumi";
const UA = "toto-sumo-bot/1.0 (personal fan game; low frequency daily fetch)";

// ---------- 場所カレンダー（奇数月・第2日曜初日・15日間）JST ----------
const JST = 9 * 3600e3;
function jstToday() {
  const d = new Date(Date.now() + JST);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
function secondSunday(y, m) {
  const wd = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return 1 + ((7 - wd) % 7) + 7;
}
function currentBasho() {
  const today = jstToday();
  const y0 = new Date(today).getUTCFullYear();
  for (const y of [y0 - 1, y0]) {
    for (const m of [1, 3, 5, 7, 9, 11]) {
      const start = Date.UTC(y, m - 1, secondSunday(y, m));
      const day = Math.floor((today - start) / 86400e3) + 1;
      // 千秋楽(15日目)翌日から表彰発表ページの取得を試み、最大2週間リトライする
      if (day >= 1 && day <= 30) {
        return { y, m, day: Math.min(day, 15), rawDay: day, key: `${y}-${String(m).padStart(2, "0")}` };
      }
    }
  }
  return null;
}
// 次の本場所（番付予想モードの答え合わせ用）
function nextBasho() {
  const today = jstToday();
  const y0 = new Date(today).getUTCFullYear();
  const cands = [];
  for (const y of [y0, y0 + 1]) {
    for (const m of [1, 3, 5, 7, 9, 11]) {
      cands.push({ y, m, start: Date.UTC(y, m - 1, secondSunday(y, m)), key: `${y}-${String(m).padStart(2, "0")}` });
    }
  }
  cands.sort((a, b) => a.start - b.start);
  return cands.find(c => c.start > today) || null;
}

// ---------- 番付文字列の正規化 ----------
function normRank(s) {
  s = s.replace(/^[東西]/, "");
  if (s === "横綱") return "Y";
  if (s === "大関") return "O";
  if (s === "関脇") return "S";
  if (s === "小結") return "K";
  let m = s.match(/^前頭(筆頭|(\d+)枚目)$/);
  if (m) return "M" + (m[2] || 1);
  m = s.match(/^十両(筆頭|(\d+)枚目)$/);
  if (m) return "J" + (m[2] || 1);
  return null;
}
const RANK_RE = /^[東西]?(横綱|大関|関脇|小結|前頭(筆頭|\d+枚目)|十両(筆頭|\d+枚目))$/;
const REC_RE = /^(\d+)勝(\d+)敗/;

// ---------- 1日分のページをパース ----------
// 戻り値: [{eRank,eName,eRec,eMark, k, wRank,wName,wRec,wMark}]
function parseDay(html) {
  // 最初の<table>（幕内）のみ対象
  const t0 = html.indexOf("<table");
  if (t0 < 0) return [];
  const t1 = html.indexOf("</table>", t0);
  const table = html.slice(t0, t1);
  const rows = table.split(/<tr[\s>]/).slice(1);
  const bouts = [];
  for (const row of rows) {
    // タグ除去 → トークン列
    const tokens = row
      .replace(/<img[^>]*alt="([^"]*)"[^>]*>/g, " $1 ") // 勝敗マークがimgの場合
      .replace(/<[^>]*>/g, "\n")
      .replace(/&nbsp;/g, " ")
      .split("\n").map(s => s.trim()).filter(Boolean)
      .filter(s => !/^https?:/.test(s));
    // 期待順: 東番付, [○●], 東力士名, 東成績, 決まり手, [○●], 西力士名, 西成績, 西番付
    const rankIdx = tokens.map((t, i) => RANK_RE.test(t) ? i : -1).filter(i => i >= 0);
    if (rankIdx.length < 2) continue;
    const recIdx = tokens.map((t, i) => REC_RE.test(t) ? i : -1).filter(i => i >= 0);
    const seg = (a, b) => tokens.slice(a + 1, b);
    const isMark = t => /^[○●□■]$/.test(t);
    const eRankRaw = tokens[rankIdx[0]], wRankRaw = tokens[rankIdx[rankIdx.length - 1]];
    const eRank = normRank(eRankRaw);
    const wRank = normRank(wRankRaw);
    if (!eRank || !wRank) continue;
    const eSide = eRankRaw.startsWith("西") ? "W" : "E";
    const wSide = wRankRaw.startsWith("西") ? "W" : "E";

    // ---- 星取なし行（未来日の取組前ページ）: [東番付, 東名, (決まり手/取組前)?, 西名, 西番付] ----
    if (recIdx.length < 2) {
      const mid = seg(rankIdx[0], rankIdx[rankIdx.length - 1]).filter(t => !isMark(t));
      if (mid.length < 2) continue;
      const eName = mid[0], wName = mid[mid.length - 1];
      const k = mid.length >= 3 ? mid[1] : null;
      bouts.push({ eRank, eSide, eName, eRec: "0勝0敗", eMark: null, k, wRank, wSide, wName, wRec: "0勝0敗", wMark: null });
      continue;
    }
    // 東側: 番付〜成績 の間で名前を拾う（マークが名前の前後に付く場合あり）
    const eSeg = seg(rankIdx[0], recIdx[0]);
    let eMark = eSeg.find(isMark) || null;
    const eName = eSeg.find(t => !isMark(t));
    const eRec = tokens[recIdx[0]];
    const wRec = tokens[recIdx[recIdx.length - 1]];
    // 中間部（東成績〜西成績）: [東マーク?] 決まり手 [西マーク?] 西名 の並び
    const mid = seg(recIdx[0], recIdx[recIdx.length - 1]);
    const nonMark = mid.filter(t => !isMark(t));
    const wName = nonMark.length ? nonMark[nonMark.length - 1] : null;
    const k = nonMark.length > 1 ? nonMark[0] : null;
    // マークの帰属: 決まり手トークンより前=東 / 後=西
    let wMark = null;
    const kPos = k ? mid.indexOf(k) : -1;
    mid.forEach((t, i) => {
      if (!isMark(t)) return;
      if (kPos >= 0 ? i < kPos : !eMark) { if (!eMark) eMark = t; }
      else if (!wMark) wMark = t;
    });
    // 西成績〜西番付の間のマークは西
    seg(recIdx[recIdx.length - 1], rankIdx[rankIdx.length - 1]).forEach(t => { if (isMark(t) && !wMark) wMark = t; });
    if (!eName || !wName) continue;
    bouts.push({ eRank, eSide, eName, eRec, eMark, k, wRank, wSide, wName, wRec, wMark });
  }
  return bouts;
}

// ---------- 休場力士欄のパース ----------
function parseKyujo(html) {
  const i = html.indexOf("休場力士");
  if (i < 0) return [];
  const t0 = html.indexOf("<table", i);
  if (t0 < 0) return [];
  const t1 = html.indexOf("</table>", t0);
  const tokens = html.slice(t0, t1)
    .replace(/<[^>]*>/g, "\n")
    .split(/[\n、,・]/).map(s => s.trim()).filter(Boolean);
  return tokens.filter(t =>
    !["幕内", "十両", "休場力士", "力士"].includes(t) &&
    !/[\d※:：\/]/.test(t) &&
    /^[぀-ヿ㐀-鿿々]+$/.test(t)
  );
}

// ---------- 新着ニュース見出しのパース ----------
function parseNews(html) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href="(https:\/\/news\.yahoo\.co\.jp\/articles\/[^"#]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 6) {
    const url = m[1];
    if (seen.has(url)) continue;
    seen.add(url);
    const title = m[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (title.length < 8) continue;
    out.push({ t: title, u: url });
  }
  return out;
}

// ---------- 表彰力士（幕内優勝・三賞）のパース ----------
// https://sports.yahoo.co.jp/sumo/basho/{yyyymm} の「表彰力士」表を対象にする。
// 同じ賞に複数受賞者がいる場合、2人目以降の行は賞名セルが空（rowspan）になる想定。
const AWARD_CATS = ["幕内優勝", "殊勲賞", "敢闘賞", "技能賞", "十両優勝"];
function parseAwards(html) {
  const i = html.indexOf("表彰力士");
  if (i < 0) return null;
  const t0 = html.indexOf("<table", i);
  if (t0 < 0) return null;
  const t1 = html.indexOf("</table>", t0);
  const table = html.slice(t0, t1);
  const rows = table.split(/<tr[\s>]/).slice(1);
  const result = { yusho: null, shukun: [], kanto: [], gino: [] };
  let curCat = null;
  for (const row of rows) {
    const tokens = row
      .replace(/<[^>]*>/g, "\n")
      .replace(/&nbsp;/g, " ")
      .split("\n").map(s => s.trim()).filter(Boolean);
    if (!tokens.length) continue;
    let rest = tokens;
    if (AWARD_CATS.includes(tokens[0])) { curCat = tokens[0]; rest = tokens.slice(1); }
    if (!curCat || !rest.length) continue;
    const [name, rank, record, heya, count] = rest;
    if (!name || name === "該当なし") continue;
    const entry = { name, rank: rank || null, record: record || null, heya: heya || null };
    if (curCat === "幕内優勝") { if (!result.yusho) result.yusho = entry; }
    else if (curCat === "殊勲賞") result.shukun.push(entry);
    else if (curCat === "敢闘賞") result.kanto.push(entry);
    else if (curCat === "技能賞") result.gino.push(entry);
    // 十両優勝は今のゲームでは未使用のため保存しない
  }
  return result.yusho ? result : null; // 優勝力士が取れなければ未発表とみなす
}

// ---------- 番付表（星取・番付表）のパース ----------
// https://sports.yahoo.co.jp/sumo/basho/{yyyymm} の東・番付・西 3列テーブルを対象。
// 番付発表後〜初日前の「次の場所」ページから新番付を取り出す（番付予想モードの正解データ）。
// 中央セルの番付ラベルには東西プレフィックスが付かない想定
// （「東横綱」のような表記は表彰力士テーブル側なので対象外にできる）。
const BZ_RANK_RE = /^(横綱|大関|関脇|小結|前頭(筆頭|\d+枚目))$/;
const NAME_RE = /^[぀-ヿ㐀-鿿々]+$/;
function parseBanzukeTable(html) {
  const out = [];
  let idx = 0;
  while (out.length < 60) {
    const t0 = html.indexOf("<table", idx);
    if (t0 < 0) break;
    const t1 = html.indexOf("</table>", t0);
    idx = t1 + 8;
    const rows = html.slice(t0, t1).split(/<tr[\s>]/).slice(1);
    for (const row of rows) {
      const tokens = row
        .replace(/<[^>]*>/g, "\n")
        .replace(/&nbsp;/g, " ")
        .split("\n").map(s => s.trim()).filter(Boolean)
        .filter(s => !/^https?:/.test(s));
      const ri = tokens.findIndex(t => BZ_RANK_RE.test(t));
      if (ri < 0) continue;
      const rank = normRank(tokens[ri]);
      if (!rank || rank[0] === "J") continue;
      const isName = t => NAME_RE.test(t) && !BZ_RANK_RE.test(t) && !REC_RE.test(t) &&
        !["休", "優勝", "幕内", "十両", "番付", "東", "西"].includes(t);
      const eName = tokens.slice(0, ri).filter(isName)[0] || null;   // 左列=東
      const wName = tokens.slice(ri + 1).filter(isName)[0] || null;  // 右列=西
      if (eName) out.push({ rank, side: "東", name: eName });
      if (wName) out.push({ rank, side: "西", name: wName });
    }
  }
  // 同名の重複を除去（幕内タブと同内容の別テーブルが並ぶ場合の保険）
  const seen = new Set();
  return out.filter(x => {
    const k = x.name;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------- オフシーズン: 新番付の取得（番付発表の月曜〜初日前） ----------
async function offseasonBanzukeFetch() {
  const today = jstToday();
  const next = nextBasho();
  if (!next) { console.log("次の場所が見つかりません"); return; }
  const announce = next.start - 13 * 86400e3; // 番付発表 = 初日13日前の月曜
  if (today < announce) { console.log("場所期間外・番付発表前のため何もしません"); return; }
  if (!existsSync(OUT)) { console.log("既存データファイルがないためスキップ"); return; }
  let prev;
  try { prev = JSON.parse(readFileSync(OUT, "utf8")); } catch (e) { console.log("既存データ読込失敗"); return; }
  if (prev.nextBanzuke && prev.nextBanzuke.bashoKey === next.key &&
    Array.isArray(prev.nextBanzuke.list) && prev.nextBanzuke.list.length >= 16) {
    console.log("新番付は取得済み。何もしません。");
    return;
  }
  const yyyymm = next.key.replace("-", "");
  let html;
  try {
    const res = await fetch(`https://sports.yahoo.co.jp/sumo/basho/${yyyymm}`, { headers: { "User-Agent": UA } });
    if (!res.ok) { console.log(`新番付ページ: HTTP ${res.status} スキップ（翌回リトライ）`); return; }
    html = await res.text();
  } catch (e) {
    console.log("新番付ページ取得失敗:", e.message);
    return;
  }
  const list = parseBanzukeTable(html);
  if (list.length < 16) {
    console.log(`新番付: 抽出できたのは${list.length}名のみ（未掲載か構造変更）。翌回リトライします。`);
    return;
  }
  prev.nextBanzuke = { bashoKey: next.key, fetchedAt: new Date().toISOString(), list };
  writeFileSync(OUT, JSON.stringify(prev, null, 1));
  console.log(`新番付を書き出し: ${next.key} / ${list.length}名（先頭: ${list.slice(0, 4).map(x => x.name).join("、")}）`);
}

// ---------- 勝者判定（マーク優先、なければ星取差分） ----------
// recMap: name -> {w, l} 直近の既知星取。片方が十両から上がってきた場合でも
// 幕内側の勝敗の増分だけで判定できるよう、勝ち数と負け数の両方を見る。
function decideWinner(b, recMap) {
  if (b.eMark === "○" || b.eMark === "□") return "e";
  if (b.wMark === "○" || b.wMark === "□") return "w";
  if (b.eMark === "●" || b.eMark === "■") return "w";
  if (b.wMark === "●" || b.wMark === "■") return "e";
  if (!b.k || b.k === "取組前") return null;
  const em = b.eRec.match(REC_RE) || [], wm = b.wRec.match(REC_RE) || [];
  const ew = parseInt(em[1] || "0", 10), el = parseInt(em[2] || "0", 10);
  const ww = parseInt(wm[1] || "0", 10), wl = parseInt(wm[2] || "0", 10);
  const pe = recMap[b.eName], pw = recMap[b.wName];
  // 星取履歴が既知の側の増分で判定（勝ちが増えた=勝利 / 負けが増えた=敗北）
  if (pe) {
    if (ew > pe.w && el === pe.l) return "e";
    if (el > pe.l && ew === pe.w) return "w";
  }
  if (pw) {
    if (ww > pw.w && wl === pw.l) return "w";
    if (wl > pw.l && ww === pw.w) return "e";
  }
  // 両者とも履歴なし（初日・両者十両上がり等）: 片方だけ白星なら判定
  if (!pe && !pw) {
    if (ew > 0 && ww === 0) return "e";
    if (ww > 0 && ew === 0) return "w";
  }
  return null;
}

// ---------- メイン ----------
const basho = currentBasho();
if (!basho) {
  // 場所期間外: 番付発表後なら「次の場所の新番付」だけ取得する（番付予想モード用）
  await offseasonBanzukeFetch();
  process.exit(0);
}
console.log(`対象: ${basho.key} / ${basho.day}日目まで（+翌日の取組）`);

// 既存データを先に読む（表彰発表まで取得済みならこれ以上巡回しない）
let prev = null;
if (existsSync(OUT)) {
  try { prev = JSON.parse(readFileSync(OUT, "utf8")); } catch (e) { }
}
if (prev && prev.bashoKey === basho.key && prev.awards && basho.rawDay > 15) {
  console.log("表彰発表まで取得済み。今場所の巡回を終了します。");
  process.exit(0);
}

const yyyymm = basho.key.replace("-", "");
const days = {};
const banzuke = new Map(); // name -> rank（初出を採用）
const recMap = {};         // name -> {w, l} 星取差分用
let kyujoToday = [];       // 本日時点の休場力士
let news = [];             // 新着ニュース見出し

const fetchDays = [];
for (let d = 1; d <= Math.min(15, basho.day + 1); d++) fetchDays.push(d);

for (const d of fetchDays) {
  const url = `${BASE}/${yyyymm}/${d}`;
  let html;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) { console.log(`day${d}: HTTP ${res.status} スキップ`); continue; }
    html = await res.text();
  } catch (e) {
    console.log(`day${d}: 取得失敗 ${e.message}`);
    continue;
  }
  const ky = parseKyujo(html);
  if (ky.length) kyujoToday = [...new Set([...kyujoToday, ...ky])];
  const nw = parseNews(html);
  if (nw.length) news = nw;
  const parsed = parseDay(html);
  if (!parsed.length) { console.log(`day${d}: 取組なし（未発表）`); continue; }
  const bouts = [];
  for (const b of parsed) {
    banzuke.has(b.eName) || banzuke.set(b.eName, { rank: b.eRank, side: b.eSide });
    banzuke.has(b.wName) || banzuke.set(b.wName, { rank: b.wRank, side: b.wSide });
    const win = decideWinner(b, recMap);
    // 不戦勝・不戦敗（休場による不成立）: □/■マーク、または決まり手欄に「不戦」を含む場合
    const isMarkFusen = m => m === "□" || m === "■";
    const fusen = isMarkFusen(b.eMark) || isMarkFusen(b.wMark) || (b.k && b.k.includes("不戦"));
    bouts.push({ e: b.eName, w: b.wName, k: (b.k && b.k !== "取組前") ? b.k : null, win, fusen: !!fusen });
  }
  // 星取更新（結果確定行のみ・勝敗両方を記録）
  for (const b of parsed) {
    if (b.k && b.k !== "取組前") {
      const upd = (name, rec) => {
        const m = rec.match(REC_RE) || [];
        const w = parseInt(m[1] || "0", 10), l = parseInt(m[2] || "0", 10);
        const p = recMap[name] || { w: 0, l: 0 };
        recMap[name] = { w: Math.max(p.w, w), l: Math.max(p.l, l) };
      };
      upd(b.eName, b.eRec);
      upd(b.wName, b.wRec);
    }
  }
  days[d] = bouts;
  const resolved = bouts.filter(x => x.win).length;
  console.log(`day${d}: ${bouts.length}番 (結果確定 ${resolved})`);
  await new Promise(r => setTimeout(r, 1500)); // 行儀よく1.5秒待つ
}

// 表彰発表（幕内優勝・三賞）: 千秋楽翌日以降のみ取得を試みる
let awards = null;
if (basho.rawDay > 15) {
  try {
    const aRes = await fetch(`https://sports.yahoo.co.jp/sumo/basho/${yyyymm}`, { headers: { "User-Agent": UA } });
    if (aRes.ok) {
      awards = parseAwards(await aRes.text());
      console.log(awards ? `表彰発表を取得: 優勝 ${awards.yusho.name}` : "表彰発表: まだ掲載されていません（翌回リトライ）");
    } else {
      console.log(`表彰発表ページ: HTTP ${aRes.status} スキップ`);
    }
  } catch (e) {
    console.log("表彰発表ページ取得失敗:", e.message);
  }
}

if (!Object.keys(days).length && !awards) {
  console.log("有効なデータが取れませんでした（既存ファイルを保持）");
  process.exit(0);
}

// 既存データとマージ（過去日の確定結果は上書きしない安全策）
let kyujoLog = {};
let injuredCarry = [];
if (prev && prev.bashoKey === basho.key) {
  if (prev.days) {
    for (const [d, bouts] of Object.entries(prev.days)) {
      const nd = days[d];
      if (!nd) { days[d] = bouts; continue; }
      // 旧データで確定済み・新データで未確定なら旧を残す
      bouts.forEach((ob, i) => { if (ob.win && nd[i] && !nd[i].win && ob.e === nd[i].e) nd[i] = ob; });
    }
  }
  kyujoLog = prev.kyujoLog || {};
  injuredCarry = prev.injuredCarry || [];
  if (!news.length && prev.news) news = prev.news;
  if (!awards && prev.awards) awards = prev.awards; // 表彰発表は一度取れたら保持
} else if (prev && prev.kyujoLog) {
  // 場所が替わった: 前場所で5日以上休場した力士 → 今場所「怪我明け」(仕様4.2 B条件)
  const count = {};
  Object.values(prev.kyujoLog).forEach(names => names.forEach(n => { count[n] = (count[n] || 0) + 1; }));
  injuredCarry = Object.entries(count).filter(([, c]) => c >= 5).map(([n]) => n);
  console.log("前場所の怪我明け持ち越し:", injuredCarry.join("、") || "なし");
}
// 本日分の休場記録を追記（同日は上書き更新）
if (kyujoToday.length) kyujoLog[String(basho.day)] = kyujoToday;

const out = {
  bashoKey: basho.key,
  updatedAt: new Date().toISOString(),
  source: "sports.yahoo.co.jp/sumo",
  banzuke: [...banzuke.entries()].map(([name, v]) => ({ name, rank: v.rank, side: v.side })),
  kyujoLog,
  injuredCarry,
  news,
  awards,
  days
};
mkdirSync("data", { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`書き出し完了: ${OUT} (力士${out.banzuke.length}名 / ${Object.keys(days).length}日分)`);
