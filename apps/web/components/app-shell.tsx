'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { Search, Sparkles, Clock, Wallet, Settings, Menu, X } from 'lucide-react';
import { ThemeToggle } from '@/components/theme-toggle';

const nav = [
  { href: '/research', label: 'Research', icon: Search },
  { href: '/analysis', label: 'Analysis', icon: Sparkles },
  { href: '/routines', label: 'Routines', icon: Clock },
  { href: '/portfolio', label: 'Portfolio', icon: Wallet },
  { href: '/settings', label: 'Settings', icon: Settings },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

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
          })}
        </nav>
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
