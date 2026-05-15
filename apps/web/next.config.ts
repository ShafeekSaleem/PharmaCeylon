import type { NextConfig } from "next";

/** Where Next proxies `/api/v1/*` in dev (Nest). Not exposed to the browser. */
const apiProxyTarget = (process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3001").replace(/\/$/, "");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@pharmaceylon/shared"],
  eslint: {
    // Monorepo hoisting can break eslint-config-next's parser path; `next lint` still runs in CI/scripts when needed.
    ignoreDuringBuilds: true,
  },
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: `${apiProxyTarget}/api/v1/:path*`,
      },
      {
        source: "/uploads/:path*",
        destination: `${apiProxyTarget}/uploads/:path*`,
      },
    ];
  },
};

export default nextConfig;
