"use client";

import { useState } from "react";
import { Button } from "../components/Button";

const ALL_KEYS = [
  "所在地","築年","構造","総戸数","階数","最寄駅","徒歩分","管理体制","管理会社",
  "設備","学区","駐車場","間取り","専有面積","バルコニー面積","階","方角",
  "リフォーム","リノベーション","室内設備"
] as const;

export default function Page() {
  const [urlsText, setUrlsText] = useState("");
  const [propertyName, setPropertyName] = useState("");
  const [scope, setScope] = useState<"部屋" | "棟">("部屋");
  const [tone, setTone] = useState<"上品・落ち着き" | "一般的" | "親しみやすい">("一般的");
  const [length, setLength] = useState(500);
  const [must, setMust] = useState<string[]>(["所在地","築年","構造","最寄駅","徒歩分"]);
  const [mustFree, setMustFree] = useState("");
  const [out, setOut] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function parseSources(input: string) {
    return input
      .split(/[\n,]+/)
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 10); // 念のため最大10件
  }

  async function onGenerate() {
    setLoading(true);
    setErr(null);
    setCopied(false);
    setOut("");

    const sources = parseSources(urlsText);
    const extra = mustFree
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
          scope,
          tone,
          length,
          mustIncludeKeys: Array.from(new Set([...must, ...extra])),
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
    <main className="max-w-3xl mx-auto px-4 py-10 space-y-8">
      <h1 className="text-2xl font-semibold">物件紹介文ジェネレーター（外販用）</h1>

      {/* 物件名 */}
      <div className="space-y-2">
        <label className="font-medium">物件名（任意）</label>
        <input
          className="w-full border rounded-md p-2"
          placeholder="例）コスモ〇〇マンション"
          value={propertyName}
          onChange={(e) => setPropertyName(e.target.value)}
        />
        <p className="text-sm text-gray-500">※ 入力した名称は“事実”として扱い、本文に使用します</p>
      </div>

      {/* 複数URL / テキスト */}
      <div className="space-y-2">
        <label className="font-medium">入力（複数URL または テキスト）</label>
        <textarea
          className="w-full border rounded-md p-3 h-36"
          placeholder={`https://example.com/foo\nhttps://example.com/bar\n…（改行またはカンマ区切りで複数OK）`}
          value={urlsText}
          onChange={(e) => setUrlsText(e.target.value)}
        />
      </div>

      {/* オプション */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="space-y-2">
          <label className="font-medium">スコープ</label>
          <select className="w-full border rounded-md p-2" value={scope} onChange={(e)=>setScope(e.target.value as any)}>
            <option value="部屋">部屋</option>
            <option value="棟">棟</option>
          </select>
        </div>
        <div className="space-y-2">
          <label className="font-medium">トーン</label>
          <select className="w-full border rounded-md p-2" value={tone} onChange={(e)=>setTone(e.target.value as any)}>
            <option>上品・落ち着き</option>
            <option>一般的</option>
            <option>親しみやすい</option>
          </select>
        </div>
        <div className="space-y-2">
          <label className="font-medium">文字数目安</label>
          <input
            type="number"
            className="w-full border rounded-md p-2"
            value={length}
            min={300}
            max={1200}
            onChange={(e)=>setLength(Number(e.target.value))}
          />
        </div>
      </div>

      {/* 必ず含めたい項目 */}
      <div className="space-y-2">
        <label className="font-medium">必ず含めたい項目（該当があれば）</label>
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
                className={`px-3 py-1 rounded-full border ${active ? "bg-black text-white" : "bg-white"}`}
              >
                {k}
              </button>
            );
          })}
        </div>
        <input
          className="w-full border rounded-md p-2"
          placeholder="自由追加（カンマ区切り）例：学区, 駐輪場"
          value={mustFree}
          onChange={(e)=>setMustFree(e.target.value)}
        />
      </div>

      {/* 実行 */}
      <div className="flex items-center gap-3">
        <Button onClick={onGenerate} disabled={loading}>
          {loading ? "生成中…" : "生成する"}
        </Button>
        <Button variant="secondary" onClick={copyOutput} disabled={!out}>
          {copied ? "コピーしました ✓" : "出力をコピー"}
        </Button>
      </div>

      {/* 結果 */}
      {err && <div className="text-red-600 whitespace-pre-wrap">{err}</div>}
      <div className="border rounded-md p-4 min-h-[160px] whitespace-pre-wrap">
        {out || "ここに生成結果が表示されます。"}
      </div>
    </main>
  );
}
