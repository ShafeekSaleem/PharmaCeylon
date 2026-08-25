import type { NextConfig } from "next";
import path from "node:path";

/** Where Next proxies `/api/v1/*` in dev (Nest). Not exposed to the browser. */
const apiProxyTarget = (process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3001").replace(/\/$/, "");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: "standalone",
  // Include traced files from shared workspaces outside apps/web.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  transpilePackages: ["@pharmaceylon/shared"],
  eslint: {
    // Monorepo hoisting can break eslint-config-next's parser path; `next lint` still runs in CI/scripts when needed.
    ignoreDuringBuilds: true,
  },
  // NMRA confirm also has a dedicated Route Handler (10m). This covers other long rewrites.
  experimental: {
    proxyTimeout: 10 * 60 * 1000,
  },
  async rewrites() {
    return [
      {
        // Filesystem Route Handlers (e.g. nmra-import/confirm) take precedence over this rewrite.
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

