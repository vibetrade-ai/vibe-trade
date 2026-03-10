import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Enable static export for CLI/npm package builds (NEXT_STATIC_EXPORT=1)
  ...(process.env.NEXT_STATIC_EXPORT === "1" && { output: "export" }),
};

export default nextConfig;
