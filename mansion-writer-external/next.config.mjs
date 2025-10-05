/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // --- ここを一時ON（あとでOFFに戻せます）---
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
