'use client';

import { useEffect, useRef, useState } from 'react';

const KEY_PREFIX = 'aistock:chat-state:v1:';

interface PersistedState {
  sessionId: string;
  chatId: number | null;
  messages: Array<Record<string, unknown>>;
  updatedAt: number;
}

/**
 * Save/restore chat state to localStorage so that navigating away from the
 * page and back preserves the conversation, model selection (caller persists
 * separately), and pinned chatId.
 *
 * Key shape: `aistock:chat-state:v1:<tab>:<scope>` where scope is the stock id
 * (or "global"). Each (tab, stock) gets its own slot, so switching stocks
 * doesn't blow away the other stock's transcript.
 */
export function useChatPersistence(args: {
  tab: 'research' | 'analysis';
  scope: string | number | null | undefined;
}) {
  const { tab, scope } = args;
  const key = `${KEY_PREFIX}${tab}:${scope ?? 'global'}`;
  const [hydrated, setHydrated] = useState(false);
  const [initial, setInitial] = useState<PersistedState | null>(null);
  const lastKeyRef = useRef<string>('');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (lastKeyRef.current === key) return;
    lastKeyRef.current = key;
    try {
      const raw = localStorage.getItem(key);
      setInitial(raw ? (JSON.parse(raw) as PersistedState) : null);
    } catch {
      setInitial(null);
    }
    setHydrated(true);
  }, [key]);

  function persist(patch: Partial<PersistedState>) {
    if (typeof window === 'undefined') return;
    try {
      const prev = (() => {
        const raw = localStorage.getItem(key);
        return raw ? (JSON.parse(raw) as PersistedState) : null;
      })();
      const nextMessages = patch.messages ?? prev?.messages ?? [];
      // Guard: never overwrite a non-empty saved transcript with an empty one.
      // This is the race that nuked history on remount: persist fired with an
      // empty messages array before the restore effect had a chance to
      // setMessages from `initial`.
      if (
        prev &&
        Array.isArray(prev.messages) &&
        prev.messages.length > 0 &&
        nextMessages.length === 0
      ) {
        return;
      }
      const next: PersistedState = {
        sessionId: patch.sessionId ?? prev?.sessionId ?? '',
        chatId: patch.chatId ?? prev?.chatId ?? null,
        messages: nextMessages,
        updatedAt: Date.now(),
      };
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* ignore quota */
    }
  }

  function clear() {
    if (typeof window === 'undefined') return;
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }

  return { hydrated, initial, persist, clear, key };
}
