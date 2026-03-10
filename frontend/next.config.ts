import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.join(__dirname),
  // Enable static export for CLI/npm package builds (NEXT_STATIC_EXPORT=1)
  ...(process.env.NEXT_STATIC_EXPORT === "1" && { output: "export" }),
};

export default nextConfig;
