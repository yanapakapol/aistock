import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV !== 'production';

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join('; ');

const config: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
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