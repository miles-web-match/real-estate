import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "物件紹介文ジェネレーター（外販向け）",
  description: "URLから自動抽出。スコープ（部屋/棟）切替・禁止語フィルタ・必須含有キー対応。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
