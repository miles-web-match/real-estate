import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { z } from "zod";
import { extractFactsFromHtml, factsToLines } from "../../../lib/extract";
import type { PropertyFacts } from "../../../lib/schema";
import { UNIT_ONLY_KEYS, UNIT_ONLY_KEYWORDS } from "../../../lib/schema";

export const runtime = "edge";

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

const BodySchema = z.object({
  // 互換：旧UIの source も受け付ける
  source: z.string().optional(),
  sources: z.array(z.string()).optional(),
  propertyName: z.string().optional(),
  tone: z.enum(["上品・落ち着き", "一般的", "親しみやすい"]),
  length: z.number().int().min(300).max(1200),
  mustIncludeKeys: z.array(z.string()).optional().default([]),
  scope: z.enum(["部屋", "棟"]).default("部屋"),
}).refine(v => (v.sources?.length || v.source?.length), {
  message: "sources もしくは source を指定してください"
});

function sanitizeForbidden(text: string) {
  let out = text;
  for (const w of BANNED_WORDS) out = out.replaceAll(w, `※${w}（表現調整）`);
  return out.trim();
}

async function fetchWithTimeout(url: string) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; MitsuiAI-PropertyScraper/1.0; +https://example.com/bot)",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(id);
  }
}

function mergeFacts(base: PropertyFacts, add: PropertyFacts): PropertyFacts {
  const out: PropertyFacts = { ...base };
  for (const [k, v] of Object.entries(add)) {
    if (!v) continue;
    if (!out[k as keyof PropertyFacts]) {
      (out as any)[k] = v;
    } else {
      const cur = String(out[k as keyof PropertyFacts] ?? "");
      const nv = String(v);
      // 長い方（情報量が多い方）を採用
      if (nv.length > cur.length) (out as any)[k] = nv;
    }
  }
  return out;
}

function stripUnitOnlyFactsForBuildingScope(
  facts: PropertyFacts,
  scope: "部屋" | "棟"
): PropertyFacts {
  if (scope === "部屋") return facts;
  const filtered: PropertyFacts = { ...facts };
  for (const k of UNIT_ONLY_KEYS) delete filtered[k];
  return filtered;
}

function stripUnitOnlySentences(text: string, scope: "部屋" | "棟") {
  if (scope === "部屋") return text;
  const sentences = text.split(/(?<=。|\n)/);
  const filtered = sentences.filter(
    (s) => !UNIT_ONLY_KEYWORDS.some((kw) => s.includes(kw))
  );
  return (filtered.join("").trim() || sentences[0] || "").trim();
}

function enforceMustInclude(
  text: string,
  facts: PropertyFacts,
  keys: string[],
  scope: "部屋" | "棟"
) {
  const unitOnly = new Set([
    "間取り","専有面積","バルコニー面積","階","方角","リフォーム","リノベーション","室内設備",
  ]);
  const applicable = scope === "棟" ? keys.filter((k) => !unitOnly.has(k)) : keys;
  const missing: Array<{ key: string; value: string }> = [];
  for (const k of applicable) {
    const v = facts[k];
    if (!v) continue;
    const ok =
      text.includes(v) ||
      text.includes(`${k}：${v}`) ||
      text.includes(`${k}:${v}`);
    if (!ok) missing.push({ key: k, value: v });
  }
  if (!missing.length) return text;
  return (
    text +
    "\n\n【情報の明示（抽出値）】\n" +
    missing.map((m) => `・${m.key}：${m.value}`).join("\n")
  );
}

function countFacts(obj: PropertyFacts) {
  return Object.values(obj).filter((v) => typeof v === "string" && v.trim()).length;
}

function factOnlyOutput(facts: PropertyFacts, scope: "部屋" | "棟") {
  const lines = Object.entries(facts)
    .filter(([, v]) => !!v)
    .map(([k, v]) => `・${k}：${v}`)
    .join("\n");

  const advice =
    scope === "棟"
      ? "（棟スコープでは専有部の情報は扱いません。建物名／所在地／築年／構造／総戸数／階数／最寄駅／徒歩分／管理体制 などをページに記載してください）"
      : "（部屋スコープでは間取り／専有面積／所在階／方角／リフォーム／室内設備 などがあると生成精度が上がります）";

  return [
    "【生成停止：情報が不足しています】",
    "ページから抽出できた事実のみを表示します（推測は行いません）。",
    "",
    "【抽出できた事実】",
    lines || "・（抽出できませんでした）",
    "",
    "【お願い】",
    advice,
  ].join("\n");
}

export async function POST(req: NextRequest) {
  try {
    const parsed = BodySchema.parse(await req.json());
    const sources = (parsed.sources ?? (parsed.source ? [parsed.source] : []))
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 10);

    const { propertyName, tone, length, mustIncludeKeys, scope } = parsed;

    let merged: PropertyFacts = {};

    // 各ソースを処理（URLなら取得→抽出、テキストなら後で事実化の材料）
    const freeTexts: string[] = [];
    for (const s of sources) {
      if (/^https?:\/\/\S+$/i.test(s)) {
        try {
          const html = await fetchWithTimeout(s);
          const { facts } = extractFactsFromHtml(html);
          merged = mergeFacts(merged, facts);
        } catch {
          // 無視（次のソースへ）
        }
      } else {
        freeTexts.push(s);
      }
    }

    // 物件名（任意）を事実として付与
    if (propertyName?.trim()) {
      merged["物件名"] = propertyName.trim();
    }

    // スコープ適用
    const scopedFacts = stripUnitOnlyFactsForBuildingScope(merged, scope);

    // 情報不足なら生成せず返す
    if (countFacts(scopedFacts) < MIN_FACTS_FOR_GENERATION) {
      return NextResponse.json({ text: factOnlyOutput(scopedFacts, scope), facts: scopedFacts });
    }

    // 生成に使う素材（抽出事実＋自由テキスト）
    const materialText = [
      factsToLines(scopedFacts),
      freeTexts.length ? `\n【追記事実（手入力）】\n${freeTexts.join("\n")}` : ""
    ].join("");

    const mustFactsLines = mustIncludeKeys
      .filter((k) => scopedFacts[k as keyof PropertyFacts])
      .map((k) => `  - ${k}: ${scopedFacts[k as keyof PropertyFacts]}`)
      .join("\n");

    const scopeRule =
      scope === "部屋"
        ? "- 専有部（間取り・専有面積・所在階・方角・室内のリフォーム/設備 等）も、事実があれば自然に記述してよい"
        : "- 建物全体（共用部・管理・規模・立地・周辺環境）にフォーカスし、専有部の情報（間取り・専有面積・所在階・方角・室内のリフォーム/設備 等）は記述しない";

    const prompt = `あなたは日本の不動産仲介サイト向けライターです。以下の「事実リスト」を厳守し、
誇大広告を避け、指定トーン「${tone}」、目安文字数「${length}字」で紹介文を書いてください。
対象スコープ: 「${scope}」

出力要件:
- 構成: 冒頭1–2文の全体像 → 立地/アクセス → 建物概要（築年・構造・規模・管理体制 等） → 周辺環境 → まとめ
- 断定・最上級・比較優位の誇張を避ける
- **事実に無い一般論（例：買い物が便利・飲食店が多い・公園がある など）は書かない**
- **事実が不足する要素は「記載なし」または言及しない**（推測禁止）
${scopeRule}
- 次の“必須含有項目（該当があれば）”は本文に自然に含めること
${mustFactsLines || "  - （該当なし）"}

禁止語の例（生成時は使わないこと。もし入力に含まれていても本文では避けること）:
${BANNED_WORDS.join("、")}

事実リスト:
${materialText}
`;

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await client.responses.create({
      model: "gpt-4.1-mini",
      instructions:
        "あなたは不動産ガイドラインに配慮できる日本語ライターです。事実のみを用い、一般論や推測は書かないでください。",
      input: prompt,
    });

    const raw = res.output_text || "";
    const cleaned = sanitizeForbidden(raw);
    const scopedCleaned = stripUnitOnlySentences(cleaned, scope);
    const finalText = enforceMustInclude(
      scopedCleaned,
      scopedFacts,
      mustIncludeKeys,
      scope
    );

    return NextResponse.json({ text: finalText, facts: scopedFacts });
  } catch (err: any) {
    const message = typeof err?.message === "string" ? err.message : "Server Error";
    return new NextResponse(message, { status: 500 });
  }
}
