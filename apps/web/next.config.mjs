import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  allowedDevOrigins: ['127.0.0.1'],
  // Turbopack resolves `next` from apps/web through the pnpm symlink into
  // <repo>/node_modules/.pnpm/..., which lives outside apps/web. Pinning the root to the
  // pnpm workspace root keeps that realpath inside the project and lets dev boot.
  turbopack: { root: path.resolve(__dirname, '..', '..') },
  // Hide the dev-mode floating indicator: it moves with the HMR state, so visual baseline
  // screenshots must exclude it.
  devIndicators: false,
  // In dev mode, Next.js rewrites /api/* to the daemon
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${process.env.NEXT_PUBLIC_DAEMON_URL || 'http://127.0.0.1:7456'}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
