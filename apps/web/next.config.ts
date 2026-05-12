import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@pharmaceylon/shared"],
  eslint: {
    // Monorepo hoisting can break eslint-config-next's parser path; `next lint` still runs in CI/scripts when needed.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
