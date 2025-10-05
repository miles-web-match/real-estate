// app/api/generate/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { z } from "zod";
import { extractFactsFromHtml, factsToLines } from "../../../lib/extract";
import type { PropertyFacts } from "../../../lib/schema";
import { UNIT_ONLY_KEYS, UNIT_ONLY_KEYWORDS } from "../../../lib/schema";

export const runtime = "edge"; // Cloudflare Pages (next-on-pages) 用

// -------------------------------
// 設定
// -------------------------------
const FETCH_TIMEOUT_MS = 10000;
const MIN_FACTS_FOR_GENERATION = 3;

const BANNED_WORDS = [
  "完全","完ぺき","絶対","万全","100％","フルリフォーム","理想",
  "日本一","日本初","業界一","超","当社だけ","他に類を見ない","抜群","一流",
  "特選","厳選","正統","由緒正しい","地域でナンバーワン",
  "最高","最高級","特級","最新","最適","至便","至近","一級","絶好",
  "買得","掘り出し物","土地値","格安","破格","特安","激安","バーゲンセール",
  "心理的瑕疵あり","告知事項あり","契約不適合責任免責","引渡し猶予","価格応談",
  "稀少物件","逸品","とっておき","人気の","新築同様","新品同様","資産価値ある","値上がりが期待できる","将来性あり",
  "自己資金0円","今だけ","今しかない","今がチャンス","高利回り","空室の心配なし",
  "売主につき手数料不要","建築確認費用は価格に含む","国土交通大臣免許だから安心です","検査済証取得物件",
  "傾斜地","路地状敷地","高圧電線下",
  "ディズニーランド","ユニバーサルスタジオジャパン","東京ドーム","ユニバ ーサルスタジオジャパ ン","東京ド ーム"
];

const BANNED_PHRASES = [
  "想定されます","といえるでしょう","と言えるでしょう","といえます","と言えます",
  "感じられます","考えられます","周辺については、","周辺については、詳細な記載はありませんが",
  "利便性が感じられます","利便性が高いと言える","でしょう。","でしょう",
];

// “上品（マンションライブラリー冒頭文風）”のスタイル指示
function stylePresetMansionLibrary(scope: "部屋" | "棟", length: number) {
  return `
【出力スタイル（マンションライブラリー冒頭文風）】
- 敬体・客観・簡潔。約${Math.max(250, Math.min(length, 600))}字、1〜2段落。
- 構成（該当があるもののみ、順序厳守）:
  1) 物件名 / 竣工年 / 構造 / 規模（階数・総戸数）
  2) アクセス（最寄駅名＋徒歩分、必要あれば主要2駅まで）
  3) 管理体制・管理会社、駐車場/駐輪場/バイク置場の有無
  4) 規約等（ペットなど）※ページに明記がある場合のみ
- 評価語・誇張・一般論・推測は書かない（例：「利便性が感じられます」「想定されます」は禁止）。
- 固有名詞表記はページの表記を尊重し、省略しない。
- ${scope === "棟"
      ? "棟モード：専有部（間取り・専有面積・所在階・方角・室内の設備/リフォーム等）は本文に入れない。"
      : "部屋モード：専有部の事実は記述可。"}
`.trim();
}

// -------------------------------
// 入出力スキーマ
// -------------------------------
const BodySchema = z.object({
  sources: z.array(z.string()).max(3).optional(), // URL or テキスト（最大3）
  source: z.string().optional(),                   // 旧互換
  propertyName: z.string().optional(),
  extraText: z.string().optional(),                // 追加のラベル:値（1行1項目）
  tone: z.enum(["上品", "一般的", "親しみやすい"]).default("上品"),
  length: z.number().int().min(200).max(1200).default(400),
  mustIncludeKeys: z.array(z.string()).optional().default([]),
  scope: z.enum(["部屋", "棟"]).default("部屋"),
}).refine(v => (v.sources?.length || v.source?.length), {
  message: "sources もしくは source を指定してください"
});

type Body = z.infer<typeof BodySchema>;
type JsonOk = { ok: true; text: string; description?: string; facts: PropertyFacts };
type JsonErr = { ok: false; error: string };

// -------------------------------
// ユーティリティ
// -------------------------------
async function fetchWithTimeout(url: string) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MitsuiAI-PropertyScraper/1.0)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    return await res.text();
  } finally { clearTimeout(id); }
}

function mergeFacts(base: PropertyFacts, add: PropertyFacts): PropertyFacts {
  const out: PropertyFacts = { ...base };
  for (const [k, v] of Object.entries(add)) {
    if (!v) continue;
    if (!out[k as keyof PropertyFacts]) (out as any)[k] = v;
    else {
      const cur = String(out[k as keyof PropertyFacts] ?? "");
      const nv = String(v);
      if (nv.length > cur.length) (out as any)[k] = nv;
    }
  }
  return out;
}

function stripUnitOnlyFactsForBuildingScope(facts: PropertyFacts, scope: "部屋" | "棟") {
  if (scope === "部屋") return facts;
  const filtered: PropertyFacts = { ...facts };
  for (const k of UNIT_ONLY_KEYS) delete filtered[k];
  return filtered;
}

function stripUnitOnlySentences(text: string, scope: "部屋" | "棟") {
  if (scope === "部屋") return text;
  const sentences = text.split(/(?<=。|\n)/);
  return (sentences.filter(s => !UNIT_ONLY_KEYWORDS.some(kw => s.includes(kw))).join("").trim()
          || sentences[0] || "").trim();
}

function dropBannedPhrases(text: string) {
  const sentences = text.split(/(?<=[。！!？\n])/);
  return sentences.filter(s => !BANNED_PHRASES.some(p => s.includes(p))).join("").trim();
}

function sanitizeForbidden(text: string) {
  let out = text;
  for (const w of BANNED_WORDS) out = out.replaceAll(w, `※${w}（表現調整）`);
  return out.trim();
}

function countFacts(obj: PropertyFacts) {
  return Object.values(obj).filter(v => typeof v === "string" && v.trim()).length;
}

function parseManualFacts(text?: string): PropertyFacts {
  const out: PropertyFacts = {};
  if (!text) return out;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([^:：]+)\s*[:：]\s*(.+?)\s*$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

function factOnlyOutput(facts: PropertyFacts, scope: "部屋"|"棟") {
  const lines = Object.entries(facts).filter(([,v])=>!!v).map(([k,v])=>`・${k}：${v}`).join("\n");
  const advice = scope === "棟"
    ? "（棟スコープでは専有部の情報は扱いません。建物名／所在地／築年／構造／総戸数／階数／最寄駅／徒歩分／管理体制 などをページに記載してください）"
    : "（部屋スコープでは間取り／専有面積／所在階／方角／リフォーム／室内設備 などがあると生成精度が上がります）";
  return ["【生成停止：情報が不足しています】","ページから抽出できた事実のみを表示します（推測は行いません）。","",
          "【抽出できた事実】", lines || "・（抽出できませんでした）","", "【お願い】", advice].join("\n");
}

// -------------------------------
// メイン
// -------------------------------
export async function POST(req: NextRequest) {
  try {
    const parsed = BodySchema.parse(await req.json()) as Body;
    const sources = (parsed.sources ?? (parsed.source ? [parsed.source] : []))
      .map(s => s.trim()).filter(Boolean).slice(0, 3);

    const { propertyName, extraText, tone, length, mustIncludeKeys, scope } = parsed;

    // 1) 収集
    let merged: PropertyFacts = {};
    for (const s of sources) {
      if (/^https?:\/\/\S+$/i.test(s)) {
        try {
          const html = await fetchWithTimeout(s);
          const { facts } = extractFactsFromHtml(html);
          merged = mergeFacts(merged, facts);
        } catch { /* ignore */ }
      } else {
        // テキスト貼付にも対応（HTMLでない場合）
        const { facts } = extractFactsFromHtml(s);
        merged = mergeFacts(merged, facts);
      }
    }
    if (propertyName?.trim()) merged["物件名"] = propertyName.trim();
    merged = { ...merged, ...parseManualFacts(extraText) };

    const scopedFacts = stripUnitOnlyFactsForBuildingScope(merged, scope);
    if (countFacts(scopedFacts) < MIN_FACTS_FOR_GENERATION) {
      const res: JsonOk = { ok: true, text: factOnlyOutput(scopedFacts, scope), description: undefined, facts: scopedFacts };
      return NextResponse.json(res);
    }

    // 2) 事実列（モデルへの入力素材）
    const lines = factsToLines(scopedFacts);
    const allowedKeys = Object.entries(scopedFacts)
      .filter(([,v]) => typeof v === "string" && v.trim())
      .map(([k]) => k);

    // 3) スタイル・指示
    const toneLine = tone === "上品" ? "上品で落ち着いた語調（です・ます）、簡潔かつ客観的。" :
                     tone === "親しみやすい" ? "親しみやすい語調だが誇張なし、簡潔で客観的。" :
                     "標準的な広告文の語調、誇張や主観なし。";

    const mustLine = (mustIncludeKeys?.length ?? 0) > 0
      ? `次の“必須含有（該当があれば）”は本文に自然に含める: ${mustIncludeKeys.join(", ")}`
      : "必須指定なし。抽出できた事実は可能な限り本文へ反映。";

    const system = [
      "あなたは日本の不動産広告文ライターです。",
      "以下の“事実リスト”に存在する情報【のみ】で本文を作成します。推測・一般論・感想は禁止。",
      `禁止語: ${BANNED_WORDS.join("、")}`,
      toneLine,
      stylePresetMansionLibrary(scope, length),
      mustLine,
      `許可キー（本文で使ってよい情報の種類）: ${allowedKeys.join(", ")}`,
      "本文は1〜2段落。箇条書きや見出しは使わない。"
    ].join("\n");

    const user = [
      propertyName?.trim() ? `物件名: ${propertyName.trim()}` : "",
      "【事実リスト】（値は本文に原文どおり記載すること）",
      lines.map(l => `・${l}`).join("\n")
    ].join("\n");

    // 4) OpenAI 呼び出し（Responses API / text.format による JSON 指定）
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

    const resp = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      instructions: system,
      input: user,
      text: {
        format: {
          type: "json_schema",
          name: "property_description_v1",
          schema: {
            type: "object",
            properties: {
              description: { type: "string", minLength: 80, description: "本文（1〜2段落）。" }
            },
            required: ["description"],
            additionalProperties: false
          },
          strict: true
        }
      }
    });

    // 5) 応答の取得とクレンジング
    const raw = (resp as any).output_text ?? ""; // 便宜プロパティ
    let description = raw;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.description === "string") description = parsed.description;
    } catch { /* raw をそのまま使用 */ }

    // フィルタ（一般論・禁止語・棟モード専有部除外）
    description = dropBannedPhrases(description);
    description = sanitizeForbidden(description);
    description = stripUnitOnlySentences(description, scope);

    const json: JsonOk = { ok: true, text: description.trim(), description: description.trim(), facts: scopedFacts };
    return NextResponse.json(json);
  } catch (err: any) {
    const json: JsonErr = { ok: false, error: String(err?.message || "Server Error") };
    // エラー時も必ず JSON で返す（フロントの緩やかパーサで読める）
    return NextResponse.json(json, { status: 400 });
  }
}
