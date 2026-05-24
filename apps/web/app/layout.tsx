import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AppShell } from '@/components/app-shell';
import { RegisterSw } from '@/components/pwa/register-sw';
import { ThemeBootstrap } from '@/components/theme-toggle';
import { LoadingBar } from '@/components/loading-bar';
import { ErrorListener } from '@/components/error-listener';

export const metadata: Metadata = {
  title: 'aistock',
  description: 'AI-driven stock research and analysis',
  manifest: '/manifest.webmanifest',
};

export const viewport: Viewport = {
  themeColor: '#0a0a0a',
  width: 'device-width',
  initialScale: 1,
  // Allow user pinch-zoom on mobile (iOS accessibility); previously hard-locked at 1.
  maximumScale: 5,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className="dark"
      suppressHydrationWarning
    >
      <head>
        {/* Pre-open TCP+TLS sockets to every host the page might hit during a
            chat turn. Saves ~100-300ms of DNS+TLS handshake cost on the first
            request to each provider — meaningful on mobile / cold serverless
            invocations. dns-prefetch is the cheaper sibling for hosts we may
            not actually call this session. */}
        <link rel="preconnect" href="https://api.mistral.ai" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://api.openai.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://api.anthropic.com" crossOrigin="anonymous" />
        <link rel="dns-prefetch" href="https://generativelanguage.googleapis.com" />
        <link rel="dns-prefetch" href="https://api.deepseek.com" />
        <link rel="dns-prefetch" href="https://api.moonshot.ai" />
      </head>
      <body className="min-h-screen antialiased">
        <ThemeBootstrap />
        <ErrorListener />
        <LoadingBar />
        <AppShell>{children}</AppShell>
        <RegisterSw />
      </body>
    </html>
  );
}
