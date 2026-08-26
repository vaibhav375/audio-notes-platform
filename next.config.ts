import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root so bundling ignores unrelated lockfiles further up
  // the filesystem.
  turbopack: { root: __dirname },
};

export default nextConfig;
