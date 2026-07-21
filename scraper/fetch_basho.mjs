// ============================================================
// トト相撲 ニュース取得スクリプト（GitHub Actions用）
//
// 【運用方針】取組・番付・優勝三賞は「取組結果登録ツール」で手動登録する。
// このスクリプトが自動で触るのは大相撲ニュース見出しだけ（Googleニュースの
// 公開RSS＝取得が許容されているフィードのみ）。取組・番付・優勝三賞など
// 手動登録した内容には一切手を加えない（news フィールドのみ更新）。
//
// 使い方:  node scraper/fetch_basho.mjs
// 依存パッケージなし（Node 20+）。
// ============================================================
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";

const OUT = "data/basho.json";
const UA = "toto-sumo-bot/1.0 (personal fan game; low frequency news fetch)";

// ---------- 大相撲ニュース見出し（Googleニュースの「大相撲」クエリ） ----------
const NEWS_RSS = "https://news.google.com/rss/search?q=" + encodeURIComponent("大相撲") + "&hl=ja&gl=JP&ceid=JP:ja";

// 簡易HTMLエンティティ・デコード（RSSタイトルは &amp; や &#39; を含む）
function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#0*(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, "&")
    .trim();
}

// GoogleニュースRSSの<item>から見出しとリンクを取り出す
function parseNews(xml) {
  const out = [];
  const seen = new Set();
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const it of items) {
    if (out.length >= 6) break;
    const tm = it.match(/<title>([\s\S]*?)<\/title>/);
    const lm = it.match(/<link>([\s\S]*?)<\/link>/);
    if (!tm || !lm) continue;
    let title = decodeEntities(tm[1]);
    const url = decodeEntities(lm[1]);
    // 「記事タイトル - メディア名」形式の末尾メディア名を落とす
    title = title.replace(/\s+-\s+[^-]+$/, "").trim();
    if (title.length < 8 || seen.has(url)) continue;
    seen.add(url);
    out.push({ t: title, u: url });
  }
  return out;
}

// ---------- メイン ----------
let news = [];
try {
  const res = await fetch(NEWS_RSS, { headers: { "User-Agent": UA } });
  if (!res.ok) { console.log(`ニュースRSS: HTTP ${res.status}。既存データを保持して終了。`); process.exit(0); }
  news = parseNews(await res.text());
} catch (e) {
  console.log("ニュースRSS取得失敗（既存データを保持して終了）:", e.message);
  process.exit(0);
}
if (!news.length) { console.log("見出しが取得できませんでした。既存データを保持して終了。"); process.exit(0); }

// 既存 data/basho.json を読み、news フィールドだけを更新する
// （取組・番付・優勝三賞など、手動登録した内容はそのまま保持）
let obj = {};
if (existsSync(OUT)) {
  try { obj = JSON.parse(readFileSync(OUT, "utf8")); } catch (e) { obj = {}; }
}
obj.news = news;
obj.newsUpdatedAt = new Date().toISOString();

mkdirSync("data", { recursive: true });
writeFileSync(OUT, JSON.stringify(obj, null, 1));
console.log(`ニュース見出し ${news.length}件を更新しました（取組・番付・優勝三賞は手動登録分を保持）。`);
console.log(" 先頭:", news[0].t);
