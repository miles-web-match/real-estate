# 物件紹介文ジェネレーター（外販向け）

URLから物件情報を抽出し、禁止語を避けた紹介文を生成します。
スコープ切替（部屋/棟）、必須含有キー（該当があれば）、禁止語フィルタに対応。

## セットアップ
1. 依存インストール: `npm i`
2. `.env.local` を作成して OpenAI キーを設定:

```
OPENAI_API_KEY=sk-xxxxx
```

3. 開発起動: `npm run dev` （http://localhost:3000）

## デプロイ（Cloudflare Pages）
- Framework preset: Next.js
- 環境変数: `OPENAI_API_KEY`
- Functions → Compatibility flags: `nodejs_compat`
- SSR ランタイムは Node（API で `export const runtime = "nodejs"`）

## 主な機能
- スクレイピング: JSON-LD / Microdata / OGP / テーブル / 正規表現
- スコープ切替: 「棟」選択時は専有部（間取り・専有面積・所在階・方角・室内設備・リフォーム/リノベ）を除外
- 必須含有: 指定キーは該当があれば本文へ。欠落時は末尾に明示枠を追記
- 禁止語フィルタ: 提供リストを反映。本文で検出した場合は `※語（表現調整）` に置換

## 注意
- 取得先サイトの利用規約/robots.txt を順守してください。
- 推測は禁止。抽出できない項目は記述しません。
- サイト特有のラベルは `lib/schema.ts` の辞書を拡張してください。
