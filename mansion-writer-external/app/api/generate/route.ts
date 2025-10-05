// app/api/generate/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { z } from "zod";
import { extractFactsFromHtml, factsToLines } from "../../../lib/extract";
import type { PropertyFacts } from "../../../lib/schema";
import { UNIT_ONLY_KEYS, UNIT_ONLY_KEYWORDS } from "../../../lib/schema";

export const runtime = "edge"; // Cloudflare Pages で必須

const FETCH_TIMEOUT_MS = 10000;
const MIN_FACTS_FOR_GENERATION = 3; // これ未満なら生成しない

// 禁止語（ご指定）
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

// 一般論・推測・断定回避の定型句を弾く
const BANNED_PHRASES = [
  "想定されます","といえるでしょう","と言えるでしょう","といえます","と言えます",
  "感じられます","考えられます","周辺については、","周辺については、詳細な記載はありませんが",
  "利便性が感じられます","利便性が高いと言える","でしょう。","でしょう",
];

const BodySchema = z.object({
  sources: z.array(z.string()).max(3).optional(),
  source: z.string().optional(), // 旧互換
  propertyName: z.string().optional(),
  extraText: z.string().optional(), // 任意の追記事実（ラベル:値 を1行1項目）
  tone: z.enum(["上品・落ち着き", "一般的", "親しみやすい"]),
  length: z.number().int().min(300).max(1200),
  mustIncludeKeys: z.array(z.string()).optional().default([]), // 初期は未選択（空）
  scope: z.enum(["部屋", "棟"]).default("部屋"),
}).refine(v => (v.sources?.length || v.source?.length), {
  message: "sources もしくは source を指定してください"
});

function sanitizeForbidden(text: string) {
  let out = text;
  for (const w of BANNED_WORDS) out = out.replaceAll(w, `※${w}（表現調整）`);
  return out.trim();
}

function dropBannedPhrases(text: string) {
  const sentences = text.split(/(?<=[。！!？\n])/);
  const filtered = sentences.filter(s =>
    !BANNED_PHRASES.some(p => s.includes(p))
  );
  return filtered.join("").trim();
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
      if (nv.length > cur.length) (out as any)[k] = nv; // 情報量の多い方
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
  if (!keys.length) return text; // 未選択なら何もしない
  const unitOnly = new Set([
    "間取り","専有面積","バルコニー面積","階","方角","リフォーム","リノベーション","室内設備",
  ]);
  const applicable = scope === "棟" ? keys.filter((k) => !unitOnly.has(k)) : keys;
  const missing: Array<{ key: string; value: string }> = [];
  for (const k of applicable) {
    const v = facts[k];
    if (!v) continue;
    const ok =
      text.includes(String(v)) ||
      text.includes(`${k}：${v}`) ||
      text.includes(`${k}:${v}`);
    if (!ok) missing.push({ key: k, value: String(v) });
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

function parseManualFacts(text?: string): PropertyFacts {
  const out: PropertyFacts = {};
  if (!text) return out;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([^:：]+)\s*[:：]\s*(.+?)\s*$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
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

// JSON スキーマ（各文は keys に 1つ以上の“根拠キー”を必須）
const JSON_SCHEMA = {
  name: "factual_mansion_write",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      sections: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: {
              type: "string",
              enum: ["intro","access","building","environment","closing"],
            },
            sentences: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  text: { type: "string" },
                  keys: {
                    type: "array",
                    items: { type: "string" },
                    minItems: 1
                  }
                },
                required: ["text","keys"]
              }
            }
          },
          required: ["name","sentences"]
        }
      }
    },
    required: ["sections"]
  },
  strict: true as const
};

export async function POST(req: NextRequest) {
  try {
    const parsed = BodySchema.parse(await req.json());
    const sources = (parsed.sources ?? (parsed.source ? [parsed.source] : []))
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 3);

    const { propertyName, extraText, tone, length, mustIncludeKeys, scope } = parsed;

    let merged: PropertyFacts = {};
    for (const s of sources) {
      if (/^https?:\/\/\S+$/i.test(s)) {
        try {
          const html = await fetchWithTimeout(s);
          const { facts } = extractFactsFromHtml(html);
          merged = mergeFacts(merged, facts);
        } catch {
          // 失敗は無視
        }
      }
    }

    if (propertyName?.trim()) merged["物件名"] = propertyName.trim();
    merged = { ...merged, ...parseManualFacts(extraText) };

    // スコープ反映
    const scopedFacts = stripUnitOnlyFactsForBuildingScope(merged, scope);

    // 情報不足なら生成せず返す
    if (countFacts(scopedFacts) < MIN_FACTS_FOR_GENERATION) {
      return NextResponse.json({ text: factOnlyOutput(scopedFacts, scope), facts: scopedFacts });
    }

    // 許可キー（存在する事実キー）のみ
    const allowedKeys = Object.entries(scopedFacts)
      .filter(([, v]) => typeof v === "string" && v.trim())
      .map(([k]) => k);

    // 事実リスト（値は本文で“そのまま”使わせる）
    const materialText = factsToLines(scopedFacts);

    const mustFactsLines = mustIncludeKeys
      .filter((k) => scopedFacts[k as keyof PropertyFacts])
      .map((k) => `  - ${k}: ${scopedFacts[k as keyof PropertyFacts]}`)
      .join("\n");

    const scopeRule =
      scope === "部屋"
        ? "- 専有部（間取り・専有面積・所在階・方角・室内のリフォーム/設備 等）も、事実があれば自然に記述してよい"
        : "- 建物全体（共用部・管理・規模・立地・周辺環境）にフォーカスし、専有部の情報（間取り・専有面積・所在階・方角・室内のリフォーム/設備 等）は記述しない";

    const mustInstruction =
      mustIncludeKeys.length === 0
        ? "- （必須指定なし）抽出できた事実は可能な限り自然に本文へ反映する"
        : `- 次の“必須含有項目（該当があれば）”は本文に自然に含めること\n${mustFactsLines || "  - （該当なし）"}`;

    // モデルへの厳格な指示（各文に許可キーをタグ付け。値は“そのまま”記載）
    const prompt = `あなたは日本の不動産仲介サイト向けライターです。
以下の「事実リスト」に含まれる情報【のみ】を用いて、5つのセクション
intro（導入）, access（アクセス）, building（建物概要）, environment（周辺環境）, closing（まとめ）
からなる文章素材を作成してください。

厳格ルール：
- 各文は、根拠となる"keys"に必ず1件以上の【許可キー】を付けること（キー以外の根拠は不可）
- 各文に含める事実の値は、事実リストの記載を【そのままの表記で】用いる（駅名・徒歩分・構造・名称などは完全一致）
- 許可キーに無い情報・一般論・推測・感想・断定的評価は【書かない】
- 許可キーに対応する事実値が含まれない文は作成しない
- セクションに相当する事実が乏しければ、そのセクション自体を省略して良い
- 文体は${tone}、目安 ${length}字（後段で連結します）
${scopeRule}
${mustInstruction}

許可キー（この中のキーだけを"keys"に使える。これ以外は使用禁止）:
${allowedKeys.join(", ")}

禁止語（本文では使わない）:
${BANNED_WORDS.join("、")}

事実リスト（値は本文に原文どおり記載すること）:
${materialText}

出力は必ず次の JSON スキーマに完全準拠。日本語の文は "text" に入れる。`;

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const res = await client.responses.create({
      model: "gpt-4.1-mini",
      response_format: { type: "json_schema", json_schema: JSON_SCHEMA },
      instructions:
        "あなたは不動産ガイドライン順守の日本語ライターです。スキーマに厳密に従い、一般論や推測は禁止。",
      input: prompt,
    });

    // JSON を厳格パース
    let payload: any;
    try {
      payload = JSON.parse(res.output_text || "{}");
    } catch {
      return NextResponse.json({ text: factOnlyOutput(scopedFacts, scope), facts: scopedFacts });
    }

    // 許可キー検査＆値の“そのまま”使用チェック＆禁止フレーズ排除
    const allowed = new Set(allowedKeys);
    const factValues = Object.fromEntries(
      Object.entries(scopedFacts).map(([k, v]) => [k, String(v ?? "")])
    );

    const paragraphs: string[] = [];
    if (Array.isArray(payload?.sections)) {
      for (const sec of payload.sections) {
        if (!Array.isArray(sec?.sentences)) continue;

        const validSentences: string[] = [];
        for (const s of sec.sentences) {
          let txt = String(s?.text ?? "").trim();
          const keys: string[] = Array.isArray(s?.keys) ? s.keys : [];

          // 許可キーのみで構成されているか
          if (!keys.length || !keys.every(k => allowed.has(k))) continue;

          // それぞれのキーの値の少なくとも1つは文中に“そのまま”含まれること
          const containsSomeValue = keys.some(k => {
            const val = factValues[k];
            return val && txt.includes(val);
          });
          if (!containsSomeValue) continue;

          // 一般論・推測フレーズを排除
          if (BANNED_PHRASES.some(p => txt.includes(p))) continue;

          validSentences.push(txt);
        }
        if (validSentences.length) paragraphs.push(validSentences.join(""));
      }
    }

    // 一文も残らなかったら安全停止
    if (!paragraphs.length) {
      return NextResponse.json({ text: factOnlyOutput(scopedFacts, scope), facts: scopedFacts });
    }

    // 結合 → 追加の後処理
    const joined = paragraphs.join("\n\n");
    const noWeasel = dropBannedPhrases(joined);
    const scopeClean = stripUnitOnlySentences(noWeasel, scope);
    const cleaned = sanitizeForbidden(scopeClean);

    // 必須含有があれば明示
    const finalText = enforceMustInclude(cleaned, scopedFacts, mustIncludeKeys, scope);

    return NextResponse.json({ text: finalText, facts: scopedFacts });
  } catch (err: any) {
    const message = typeof err?.message === "string" ? err.message : "Server Error";
    return new NextResponse(message, { status: 500 });
  }
}
