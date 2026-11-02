import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  // Next 16 locks one dev server per distDir; making distDir injectable lets a second
  // isolated instance run for verification without disturbing the one already running.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // `next dev` takes its port from the injected PORT (decided by tools-dev, see
  // tools/dev/src/index.ts). Only allowed dev hostnames are declared here: Next matches
  // on hostname, not port, so a port change never requires touching this file.
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  // Turbopack resolves `next` from apps/web through the pnpm symlink into
  // <repo>/node_modules/.pnpm/..., which lives outside apps/web. Pinning the root to the
  // pnpm workspace root keeps that realpath inside the project and lets dev boot.
  turbopack: { root: path.resolve(__dirname, '..', '..') },
  // Hide the dev-mode floating indicator: it moves with the HMR state, so visual baseline
  // screenshots must exclude it.
  devIndicators: false,
  // In dev mode, Next.js rewrites /api/* to the daemon. Mirrors open-design: tools-dev
  // allocates the daemon port before spawning web and injects it here, so the browser
  // only ever calls its own origin and a dynamic port never reaches client code.
  async rewrites() {
    const daemonOrigin =
      process.env.NEXT_PUBLIC_DAEMON_URL || `http://127.0.0.1:${process.env.OD_PORT || 7456}`;
    return [
      {
        source: '/api/:path*',
        destination: `${daemonOrigin}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
