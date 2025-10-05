"use client";

import { useState } from "react";
import { Button } from "../components/Button";

type Tone = "上品・落ち着き" | "一般的" | "親しみやすい";
type Scope = "部屋" | "棟";

const CANDIDATE_KEYS = [
  "所在地","築年","構造","総戸数","階数","最寄駅","徒歩分","管理体制","管理会社","設備","学区","駐車場",
  "間取り","専有面積","バルコニー面積","階","方角","リフォーム","リノベーション","室内設備",
];

export default function Home() {
  const [source, setSource] = useState("");
  const [tone, setTone] = useState<Tone>("上品・落ち着き");
  const [length, setLength] = useState(500);
  const [scope, setScope] = useState<Scope>("部屋");
  const [mustInclude, setMustInclude] = useState<string[]>(["所在地", "最寄駅"]);
  const [extraKeys, setExtraKeys] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");

  const mergedKeys = Array.from(new Set([
    ...mustInclude,
    ...extraKeys.split(",").map((s) => s.trim()).filter(Boolean),
  ]));

  const onToggleKey = (k: string) => {
    setMustInclude((prev) =>
      prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k],
    );
  };

  const onGenerate = async () => {
    setLoading(true);
    setError("");
    setResult("");
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, tone, length, scope, mustIncludeKeys: mergedKeys }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setResult(data.text);
    } catch (e: any) {
      setError(e.message || "不明なエラー");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="container-narrow py-8 space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">物件紹介文ジェネレーター（外販向け）</h1>
        <p className="text-sm text-neutral-600">
          URLから要点抽出。スコープ（部屋/棟）切替・禁止語フィルタ・必須含有キー対応。
        </p>
      </header>

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <label className="block text-sm font-medium">スコープ</label>
          <div className="flex rounded-xl border border-neutral-200 overflow-hidden">
            {(["部屋","棟"] as Scope[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setScope(s)}
                className={"flex-1 px-3 py-2 text-sm " + (scope === s ? "bg-black text-white" : "bg-white text-black")}
              >
                {s}
              </button>
            ))}
          </div>
          <p className="text-xs text-neutral-500">
            「棟」を選ぶと、間取り・専有面積・方角・リフォーム等の“部屋専用情報”は自動で除外。
          </p>
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-medium">トーン</label>
          <select
            value={tone}
            onChange={(e) => setTone(e.target.value as Tone)}
            className="input"
          >
            <option>上品・落ち着き</option>
            <option>一般的</option>
            <option>親しみやすい</option>
          </select>
        </div>

        <div className="space-y-2">
          <label className="block text-sm font-medium">目安文字数：{length}文字</label>
          <input
            type="range"
            min={300}
            max={800}
            step={50}
            value={length}
            onChange={(e) => setLength(parseInt(e.target.value, 10))}
            className="w-full"
          />
        </div>
      </section>

      <section className="space-y-3">
        <label className="block text-sm font-medium">入力（物件URL または テキスト）</label>
        <textarea
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder={`例）https://example.com/property/123

テキスト例（ラベル:値）:
所在地：東京都板橋区弥生町…
築年：1991年
構造：RC
総戸数：24戸
最寄駅：東武東上線「中板橋」
徒歩分：6分
管理体制：巡回
設備：オートロック、宅配ボックス
（部屋）間取り：2LDK／専有面積：55.2m²／方角：南 など`}
          className="textarea"
        />
      </section>

      <section className="space-y-2">
        <label className="block text-sm font-medium">必ず含めたい項目（該当があれば）</label>
        <div className="flex flex-wrap gap-2">
          {CANDIDATE_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => onToggleKey(k)}
              className={"badge " + (mustInclude.includes(k) ? "bg-black text-white border-black" : "bg-white text-black border-neutral-300")}
              title={scope === "棟" && ["間取り","専有面積","バルコニー面積","階","方角","リフォーム","リノベーション","室内設備"].includes(k)
                ? "棟スコープでは自動的に無視されます" : undefined}
            >
              {k}
            </button>
          ))}
        </div>
        <input
          value={extraKeys}
          onChange={(e) => setExtraKeys(e.target.value)}
          placeholder="自由追加（カンマ区切り）例：学区, 駐輪場"
          className="input"
        />
        <p className="text-xs text-neutral-500">
          値が抽出できなかった項目は自動スキップ（推測しません）。
        </p>
      </section>

      <div className="flex items-center gap-3">
        <Button onClick={onGenerate} disabled={loading || !source.trim()} color="orange" className="min-w-36">
          {loading ? "生成中…" : "生成する"}
        </Button>
        {error && <span className="text-red-600 text-sm">{error}</span>}
      </div>

      <section className="card p-4">
        <label className="block text-sm font-medium mb-2">出力</label>
        <div className="min-h-40 whitespace-pre-wrap">
          {result || "ここに生成結果が表示されます。"}
        </div>
      </section>
    </main>
  );
}
