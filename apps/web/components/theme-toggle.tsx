'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

type Theme = 'dark' | 'light';

const KEY = 'aistock:theme';

export function applyTheme(t: Theme) {
  const root = document.documentElement;
  root.classList.toggle('dark', t === 'dark');
  root.classList.toggle('light', t === 'light');
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* ignore */
  }
}

export function ThemeBootstrap() {
  // Runs once on mount to read saved theme (or system preference) and apply.
  useEffect(() => {
    let saved: Theme | null = null;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw === 'dark' || raw === 'light') saved = raw;
    } catch {
      /* ignore */
    }
    const sys: Theme = window.matchMedia('(prefers-color-scheme: light)').matches
      ? 'light'
      : 'dark';
    applyTheme(saved ?? sys);
  }, []);
  return null;
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark');
  useEffect(() => {
    setTheme(document.documentElement.classList.contains('light') ? 'light' : 'dark');
  }, []);
  function flip() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setTheme(next);
  }
  return (
    <button
      type="button"
      onClick={flip}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      aria-label="Toggle theme"
    >
      {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
