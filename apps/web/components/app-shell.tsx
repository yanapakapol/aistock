'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { Search, Sparkles, Clock, Wallet, Settings, Menu, X, LogOut, Users, Compass } from 'lucide-react';
import { ThemeToggle } from '@/components/theme-toggle';
import { PrefetchLink } from '@/components/prefetch-link';
import { CapRequestButton } from '@/components/cap-request-button';

// Per-nav API endpoints to warm on hover. The page bundle is already
// prefetched by Next; this prefetches the JSON payload the page mounts with,
// so the destination feels instant. Endpoints not listed here just behave like
// plain <Link>.
const NAV_PREFETCH: Record<string, string[]> = {
  '/picker': ['/api/portfolio'],
  '/portfolio': ['/api/portfolio'],
  '/routines': ['/api/routines'],
  '/research': ['/api/portfolio'],
  '/analysis': ['/api/portfolio'],
};

const nav = [
  { href: '/picker', label: 'Picker', icon: Compass },
  { href: '/research', label: 'Research', icon: Search },
  { href: '/analysis', label: 'Analysis', icon: Sparkles },
  { href: '/routines', label: 'Routines', icon: Clock },
  { href: '/portfolio', label: 'Portfolio', icon: Wallet },
  { href: '/settings', label: 'Settings', icon: Settings },
] as const;

// Nav items only shown when the session belongs to an admin. Kept separate so
// non-admin renders skip them entirely (the gate is also enforced server-side
// in the page itself and at every /api/admin/* endpoint — this is purely UX).
const adminNav = [
  { href: '/admin/users', label: 'Users', icon: Users },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [me, setMe] = useState<{
    username: string;
    isAdmin: boolean;
    role?: 'admin' | 'user' | 'guest';
  } | null>(null);
  // Tri-state for /api/auth/me: 'pending' (unknown — still in flight),
  // 'loaded' (response arrived, `me` is either user-object or null). Lets us
  // distinguish "loading, don't render yet" from "definitely logged out" so
  // we can show optimistic placeholders without flashing wrong content.
  const [meStatus, setMeStatus] = useState<'pending' | 'loaded'>('pending');
  // Fire ONCE on mount — not on every pathname change. The response carries
  // Cache-Control: private, max-age=300, so logout/login changes are picked up
  // within 5 min anyway (and logout/login itself hard-navigates). Cuts one DB
  // call per client-side navigation. Critically: render is NOT blocked on this
  // promise; the main nav paints synchronously with `me === null` and updates
  // in place once the response lands. Only admin-only items wait for confirm.
  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then(
        (j: {
          user?: { username: string; isAdmin: boolean; role?: 'admin' | 'user' | 'guest' } | null;
        }) => setMe(j.user ?? null),
      )
      .catch(() => undefined)
      .finally(() => setMeStatus('loaded'));
  }, []);
  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' } });
    window.location.href = '/login';
  }

  // Close the drawer on route change.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  return (
    <div className="flex h-screen">
      {/* Sidebar — collapses to off-canvas drawer below md. */}
      <aside
        className={cn(
          'shrink-0 border-r border-border bg-muted/30 p-3 flex flex-col',
          // Desktop: always visible inline.
          'md:relative md:w-56 md:translate-x-0',
          // Mobile: fixed off-canvas drawer.
          'fixed inset-y-0 left-0 z-40 w-64 transition-transform duration-200',
          menuOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between px-2 py-3">
          <span className="text-sm font-semibold tracking-tight">aistock</span>
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <button
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
              onClick={() => setMenuOpen(false)}
              aria-label="Close menu"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <nav className="mt-2 flex flex-col gap-0.5">
          {nav.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <PrefetchLink
                key={href}
                href={href}
                prefetchUrls={NAV_PREFETCH[href]}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground',
                  active && 'bg-accent text-foreground',
                )}
              >
                <Icon className="h-4 w-4" />
                {label}
              </PrefetchLink>
            );
          })}
          {me?.isAdmin
            ? adminNav.map(({ href, label, icon: Icon }) => {
                const active = pathname === href || pathname.startsWith(`${href}/`);
                return (
                  <Link
                    key={href}
                    href={href}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground',
                      active && 'bg-accent text-foreground',
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </Link>
                );
              })
            : null}
        </nav>
        {me ? (
          <div className="mt-auto border-t border-border pt-3">
            <div className="flex items-center justify-between px-2 text-xs">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium text-foreground">{me.username}</span>
                  <span
                    className={cn(
                      'shrink-0 rounded px-1 py-0 text-[9px] font-medium uppercase tracking-wide',
                      me.role === 'admin'
                        ? 'bg-foreground/10 text-foreground'
                        : me.role === 'guest'
                          ? 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-400'
                          : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {me.role ?? (me.isAdmin ? 'admin' : 'user')}
                  </span>
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {me.isAdmin
                    ? 'uses env keys'
                    : me.role === 'guest'
                      ? "uses admin's keys · data wiped weekly"
                      : 'own keys only'}
                </div>
              </div>
              <button
                type="button"
                onClick={logout}
                title="Log out"
                className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </div>
            {/* Cap-increase request shortcut for non-admins with a daily cap.
                Hidden for admins and unlimited users by the component itself. */}
            <div className="px-2">
              <CapRequestButton />
            </div>
          </div>
        ) : meStatus === 'pending' ? (
          // Skeleton: reserve the footer's vertical space while /api/auth/me
          // is in flight so the nav layout doesn't shift when the user chip
          // appears. Pulsing bars hint that something is loading without
          // blocking the rest of the shell from painting.
          <div className="mt-auto border-t border-border pt-3" aria-hidden="true">
            <div className="flex items-center justify-between px-2">
              <div className="space-y-1.5">
                <div className="h-2.5 w-20 animate-pulse rounded bg-muted" />
                <div className="h-2 w-28 animate-pulse rounded bg-muted/60" />
              </div>
              <div className="h-5 w-5 animate-pulse rounded bg-muted" />
            </div>
          </div>
        ) : null}
      </aside>

      {/* Backdrop for mobile drawer */}
      {menuOpen ? (
        <button
          type="button"
          aria-label="Close menu"
          className="fixed inset-0 z-30 bg-background/70 backdrop-blur-sm md:hidden"
          onClick={() => setMenuOpen(false)}
        />
      ) : null}

      <main className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile-only top bar with hamburger + current section label. */}
        <header className="flex items-center gap-2 border-b border-border px-3 py-2 md:hidden">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label="Open menu"
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="text-sm font-semibold capitalize">
            {pathname.replace(/^\//, '') || 'aistock'}
          </span>
        </header>
        <div className="flex-1 overflow-hidden">{children}</div>
      </main>
    </div>
  );
}
