import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV !== 'production';
// Vercel preview deployments inject vercel.live's feedback widget script.
// On prod / self-host this is a no-op (Vercel doesn't add it). We allow it
// only on Vercel deploys so the CSP error in the console goes away.
const onVercel = !!process.env.VERCEL;
const vercelScript = onVercel ? ' https://vercel.live' : '';
const vercelConnect = onVercel ? ' https://vercel.live wss://ws-us3.pusher.com' : '';
const vercelFrame = onVercel ? ' https://vercel.live' : '';

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}${vercelScript}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: https:`,
  "font-src 'self' data:",
  `connect-src 'self'${vercelConnect}`,
  `frame-src 'self'${vercelFrame}`,
  "frame-ancestors 'none'",
].join('; ');

const config: NextConfig = {
  reactStrictMode: true,
  // `output: 'standalone'` was here for Docker / self-hosted Node deploys.
  // REMOVED for Vercel: standalone mode changes Next.js's build output to
  // a self-contained server.js bundle, and Vercel's deploy pipeline
  // doesn't (consistently) detect when route bundles change inside that
  // output — explaining why 10+ commits to /api/chat appeared to deploy
  // but actually kept the stale function. Without `standalone`, Vercel
  // gets the default per-route serverless function output and re-uploads
  // each route's bundle when it changes.
  //
  // If you self-host on Docker again, re-add this and use the included
  // .next/standalone/server.js entrypoint.
  //
  // Gzip text/JSON responses. Redundant on Vercel (edge already compresses) but
  // load-bearing on self-hosted / Oracle Cloud + Node server. Cheap to keep.
  compress: true,
  serverExternalPackages: [
    '@primno/dpapi',
    'node-gyp-build',
    'postgres',
    'yahoo-finance2',
    '@deno/shim-deno',
    'web-push',
    'croner',
    'cron-parser',
    '@modelcontextprotocol/sdk',
    'mcp-handler',
  ],
  experimental: {
    typedRoutes: true,
  },
  webpack(cfg, { isServer }) {
    if (!isServer) {
      // Client-only: stub native modules + node: core so they never bundle.
      cfg.externals = [
        ...(cfg.externals || []),
        ({ request }: { request?: string }, cb: (err?: unknown, result?: string) => void) => {
          if (!request) return cb();
          if (
            request === '@primno/dpapi' ||
            request === 'node-gyp-build' ||
            request === 'yahoo-finance2' ||
            request === '@deno/shim-deno' ||
            request === 'web-push'
          ) {
            return cb(null, `commonjs ${request}`);
          }
          cb();
        },
      ];
      cfg.resolve = cfg.resolve || {};
      cfg.resolve.fallback = {
        ...(cfg.resolve.fallback || {}),
        fs: false,
        net: false,
        tls: false,
        child_process: false,
        crypto: false,
        path: false,
        os: false,
        stream: false,
        zlib: false,
        http: false,
        https: false,
      };
    }
    return cfg;
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Content-Security-Policy',
            value: csp,
          },
        ],
      },
    ];
  },
};

export default config;