"use client";

import { useMemo, useState } from "react";
import { Button } from "../components/Button";

const ALL_KEYS = [
  "物件名","所在地","築年","構造","総戸数","階数",
  "最寄駅","徒歩分","管理体制","管理会社",
  "設備","学区","駐車場",
  "間取り","専有面積","バルコニー面積","階","方角",
  "リフォーム","リノベーション","室内設備"
] as const;

type Scope = "部屋" | "棟";
type Tone = "上品・落ち着き" | "一般的" | "親しみやすい";

export default function Page() {
  // 入力（左）
  const [url1, setUrl1] = useState("");
  const [url2, setUrl2] = useState("");
  const [url3, setUrl3] = useState("");
  const [propertyName, setPropertyName] = useState("");
  const [extraText, setExtraText] = useState(""); // 任意追記事実（ラベル:値）
  const [scope, setScope] = useState<Scope>("部屋");
  const [tone, setTone] = useState<Tone>("上品・落ち着き");
  const [length, setLength] = useState(500);
  const [must, setMust] = useState<string[]>([]); // 初期は未選択
  const [mustFree, setMustFree] = useState("");
  const [showExtra, setShowExtra] = useState(false);

  // 出力（右）
  const [out, setOut] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const sources = useMemo(
    () => [url1, url2, url3].map(s => s.trim()).filter(Boolean),
    [url1, url2, url3]
  );

  async function onGenerate() {
    setLoading(true);
    setErr(null);
    setCopied(false);
    setOut("");

    const extraKeys = mustFree
      .split(/[、,]/)
      .map(s => s.trim())
      .filter(Boolean);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sources,
          propertyName: propertyName.trim() || undefined,
          extraText: extraText.trim() || undefined,
          scope,
          tone,
          length,
          mustIncludeKeys: Array.from(new Set([...must, ...extraKeys])),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(typeof data === "string" ? data : (data?.error || "Server Error"));
      setOut(data.text || "");
    } catch (e: any) {
      setErr(e?.message || "生成に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  async function copyOutput() {
    if (!out) return;
    await navigator.clipboard.writeText(out);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <h1 className="text-2xl font-semibold mb-1">物件紹介文ジェネレーター（外販向け）</h1>
      <p className="text-sm text-gray-600 mb-6">
        URLから要点抽出。スコープ（部屋/棟）切替・禁止語フィルタ・必須含有にも対応。
      </p>

      {/* 2カラムレイアウト */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* 左カラム：入力 */}
        <section className="space-y-6">
          {/* スコープ / トーン / 文字数 */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">スコープ</label>
              <div className="flex gap-3">
                <label className="flex items-center gap-1">
                  <input type="radio" name="scope" value="部屋"
                         checked={scope === "部屋"} onChange={() => setScope("部屋")} />
                  部屋
                </label>
                <label className="flex items-center gap-1">
                  <input type="radio" name="scope" value="棟"
                         checked={scope === "棟"} onChange={() => setScope("棟")} />
                  棟
                </label>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                「棟」を選ぶと、間取り・専有面積・所在階・方角・リフォーム等の“部屋専用情報”は自動で除外。
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">トーン</label>
              <select
                className="w-full border rounded-md p-2"
                value={tone}
                onChange={(e)=>setTone(e.target.value as Tone)}
              >
                <option>上品・落ち着き</option>
                <option>一般的</option>
                <option>親しみやすい</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">
                目安文字数：{length}文字
              </label>
              <input
                type="range"
                min={300}
                max={1200}
                step={50}
                value={length}
                onChange={(e)=>setLength(Number(e.target.value))}
                className="w-full"
              />
            </div>
          </div>

          {/* 物件名（任意） */}
          <div>
            <label className="block text-sm font-medium mb-1">物件名（任意）</label>
            <input
              className="w-full border rounded-md p-2"
              placeholder="例）コスモ〇〇マンション"
              value={propertyName}
              onChange={(e)=>setPropertyName(e.target.value)}
            />
          </div>

          {/* URL 3枠 */}
          <div>
            <label className="block text-sm font-medium mb-2">URL（最大3件）</label>
            <div className="space-y-2">
              <input className="w-full border rounded-md p-2" placeholder="URL 1"
                     value={url1} onChange={(e)=>setUrl1(e.target.value)} />
              <input className="w-full border rounded-md p-2" placeholder="URL 2（任意）"
                     value={url2} onChange={(e)=>setUrl2(e.target.value)} />
              <input className="w-full border rounded-md p-2" placeholder="URL 3（任意）"
                     value={url3} onChange={(e)=>setUrl3(e.target.value)} />
            </div>
          </div>

          {/* 必ず含めたい項目（初期は未選択） */}
          <div>
            <div className="flex items-center justify-between">
              <label className="block text-sm font-medium">必ず含めたい項目（該当があれば）</label>
              <button
                type="button"
                className="text-xs underline text-gray-600"
                onClick={() => setMust([])}
              >
                クリア
              </button>
            </div>
            <p className="text-xs text-gray-500 mb-2">
              ※ 何も選択されていない場合は、抽出できた情報を可能な限り本文に反映して生成します。
            </p>
            <div className="flex flex-wrap gap-2">
              {ALL_KEYS.map(k => {
                const active = must.includes(k);
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() =>
                      setMust(prev => (prev.includes(k) ? prev.filter(x=>x!==k) : [...prev, k]))
                    }
                    className={`px-3 py-1 rounded-full border text-sm ${active ? "bg-black text-white" : "bg-white"}`}
                  >
                    {k}
                  </button>
                );
              })}
            </div>
            <input
              className="w-full border rounded-md p-2 mt-2"
              placeholder="自由追加（カンマ区切り）例：学区, 駐輪場"
              value={mustFree}
              onChange={(e)=>setMustFree(e.target.value)}
            />
          </div>

          {/* 追記事実（任意・折りたたみ） */}
          <div>
            <button
              type="button"
              className="text-sm underline"
              onClick={() => setShowExtra(v => !v)}
            >
              {showExtra ? "▼ 追記事実を隠す" : "▶ 追記事実を追加（任意・ラベル:値 で1行1項目）"}
            </button>
            {showExtra && (
              <>
                <textarea
                  className="w-full border rounded-md p-3 h-28 mt-2"
                  placeholder={`例：\n所在地: 東京都〇〇区〇〇\n築年: 1991年\n構造: RC\n総戸数: 24戸`}
                  value={extraText}
                  onChange={(e)=>setExtraText(e.target.value)}
                />
                <p className="text-xs text-gray-500 mt-1">
                  ※ ここに書いた内容は抽出結果にマージされます（推測は書かないでください）
                </p>
              </>
            )}
          </div>

          {/* 実行ボタン */}
          <div className="flex items-center gap-3">
            <Button onClick={onGenerate} disabled={loading || sources.length === 0}>
              {loading ? "生成中…" : "生成する"}
            </Button>
          </div>

          {err && <div className="text-red-600 whitespace-pre-wrap">{err}</div>}
        </section>

        {/* 右カラム：出力 */}
        <aside className="md:sticky md:top-6 h-fit">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-lg font-medium">出力</h2>
            <Button variant="secondary" onClick={async()=>{ await copyOutput(); }} disabled={!out}>
              {copied ? "コピーしました ✓" : "コピー"}
            </Button>
          </div>
          <div className="border rounded-md p-4 min-h-[300px] whitespace-pre-wrap bg-white">
            {out || "ここに生成結果が表示されます。"}
          </div>
        </aside>
      </div>
    </main>
  );
}
