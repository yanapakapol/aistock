import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AppShell } from '@/components/app-shell';
import { RegisterSw } from '@/components/pwa/register-sw';
import { ThemeBootstrap } from '@/components/theme-toggle';
import { LoadingBar } from '@/components/loading-bar';

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
      <body className="min-h-screen antialiased">
        <ThemeBootstrap />
        <LoadingBar />
        <AppShell>{children}</AppShell>
        <RegisterSw />
      </body>
    </html>
  );
}
