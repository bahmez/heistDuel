import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@repo/stellar", "@repo/ui"],
  turbopack: {},
};

export default nextConfig;
