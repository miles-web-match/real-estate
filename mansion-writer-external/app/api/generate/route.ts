// app/api/generate/route.ts
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { z } from "zod";
import { extractFactsFromHtml, factsToLines } from "../../../lib/extract";
import type { PropertyFacts } from "../../../lib/schema";
import { UNIT_ONLY_KEYS, UNIT_ONLY_KEYWORDS } from "../../../lib/schema";

export const runtime = "edge"; // Cloudflare Pages (next-on-pages) 要件

const FETCH_TIMEOUT_MS = 10000;

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
  "ディズニーランド","ユニバーサルスタジオジャパン","東京ドーム"
];

const InputSchema = z.object({
  scope: z.enum(["unit", "building"]),                 // 部屋 or 棟
  tone: z.enum(["formal","neutral","friendly"]),       // トーン
  targetLength: z.number().min(100).max(1200),         // 目安文字数
  name: z.string().optional(),                         // 物件名（任意）
  urls: z.array(z.string().url()).max(3),              // 最大3URL
  includeKeys: z.array(z.string()).optional(),         // “必ず含めたい”項目（未選択なら null/undefined）
  extraMusts: z.array(z.string()).optional(),          // 追記事項（任意）
});

type Input = z.infer<typeof InputSchema>;

async function fetchWithTimeout(url: string) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const html = await res.text();
    return html;
  } finally {
    clearTimeout(id);
  }
}

function buildConstraints(scope: "unit" | "building", includeKeys: string[] | undefined) {
  // 棟モードでは、部屋専用の情報を禁止
  const mustExclude = scope === "building"
    ? [...UNIT_ONLY_KEYS, ...UNIT_ONLY_KEYWORDS]
    : [];

  // “必ず含めたい”が空 ⇒ 何も選択されていない → 可能な限り全部入れる
  const includePolicy = (includeKeys && includeKeys.length > 0)
    ? `次のラベルに該当する情報は、本文に必ず含める: ${includeKeys.join(", ")}。`
    : `特にラベル指定が無い場合は、抽出できた正確な情報は可能な限り本文に含める。`;

  return { mustExclude, includePolicy };
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const input = InputSchema.parse(body) as Input;

    // 1) URL から HTML を取得 & 事実抽出（lib/extract.ts）
    const htmlList = await Promise.all(
      input.urls.map((u) => fetchWithTimeout(u).catch(() => "")) // 失敗は空文字に
    );
    const extracted: PropertyFacts[] = [];
    for (const html of htmlList) {
      if (!html) continue;
      const facts = await extractFactsFromHtml(html);
      extracted.push(facts);
    }

    // 2) 事実を“箇条書きテキスト”へ整形（モデルにはこれだけ渡す）
    const factLines = factsToLines(extracted);

    // 3) 追加で“必ず入れたい”自由記述
    const extraMusts = input.extraMusts?.filter(Boolean) ?? [];

    // 4) 棟/部屋ごとの制約組み立て
    const { mustExclude, includePolicy } = buildConstraints(input.scope, input.includeKeys);

    // 5) プロンプト（モデルには曖昧な推測を絶対させない）
    const nameLine = input.name ? `物件名: ${input.name}\n` : "";
    const system = [
      "あなたは日本の不動産広告文ライターです。",
      "以下の箇条書き“事実リスト”に書かれている内容の**み**を使って文章を作成します。",
      "リストに無い事項は**書かない**（推測・一般論・想像は禁止）。",
      `禁止ワード（使わない）: ${BANNED_WORDS.join("、")}`,
      input.scope === "building"
        ? "今は“棟（マンション全体）”の説明モードです。部屋位置・方角・室内設備・リフォーム/リノベ等の“専有部情報”は本文に入れない。"
        : "今は“部屋（専有部）”の説明モードです。部屋に関する情報は許可されます。",
      includePolicy,
      mustExclude.length
        ? `本文に含めてはならないラベル/語: ${mustExclude.join("、")}`
        : "",
      "本文は日本語。社名や自社強調は入れない。誇大表現は避ける。事実ベースで簡潔に。",
    ].filter(Boolean).join("\n");

    const user = [
      nameLine,
      "【事実リスト】（この箇条書きに存在する内容だけを使う）",
      factLines.length ? factLines.map((l) => `・${l}`).join("\n") : "（該当なし）",
      extraMusts.length ? `\n【必ず本文に反映】\n${extraMusts.map((s) => `・${s}`).join("\n")}` : "",
      `\n出力要件:\n- 文字量の目安: 約${input.targetLength}文字\n- 箇条書きは使わず本文のみ\n- 不明な点は書かない。一般的な推測の文（「〜と想定されます」「〜が感じられます」など）も禁止`,
    ].join("\n");

    // 6) OpenAI 呼び出し（Responses API）— ここが修正ポイント
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini", // お好みで
      input: [
        { role: "system", content: system },
        { role: "user", content: user }
      ],
      // ❗ 旧: response_format → 新: text.format に移行
      text: {
        format: {
          type: "json_schema",
          name: "property_description",
          schema: {
            type: "object",
            properties: {
              description: { type: "string", minLength: 50 },
              usedFacts: { type: "array", items: { type: "string" } },
              skippedFacts: { type: "array", items: { type: "string" } }
            },
            required: ["description"],
            additionalProperties: false
          },
          strict: true
        }
      }
    });

    // DataCamp の例と同じく、output_text に JSON 文字列が入る想定
    // 参考: “text.format” の使用例（外部記事）に準拠
    // https://www.datacamp.com/tutorial/openai-responses-api
    const raw = response.output_text ?? "";
    let parsed: { description: string; usedFacts?: string[]; skippedFacts?: string[] };

    try {
      parsed = JSON.parse(raw);
    } catch {
      // 念のためテキストのみ返すフォールバック
      parsed = { description: raw };
    }

    // 禁止語の最終チェック（万一混入時は削除）
    let safe = parsed.description || "";
    for (const ng of BANNED_WORDS) {
      const re = new RegExp(ng, "g");
      safe = safe.replace(re, "");
    }

    // 棟モードの禁止（専有部ニュアンスの）単語ざっくりフィルタ
    if (input.scope === "building") {
      const roughUnitWords = ["室内", "専有", "リフォーム", "リノベーション", "床暖房", "システムキッチン", "ウォークインクローゼット"];
      const re = new RegExp(roughUnitWords.join("|"), "g");
      safe = safe.replace(re, "");
    }

    return NextResponse.json(
      {
        ok: true,
        description: safe.trim(),
        debug: {
          usedFacts: parsed.usedFacts ?? [],
          skippedFacts: parsed.skippedFacts ?? [],
        }
      },
      { status: 200 }
    );
  } catch (err: any) {
    const msg = err?.message || "Unexpected error";
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}
