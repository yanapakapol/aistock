'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Tracks the client-side identity of a chat conversation so multiple
 * turns map to a single `chats` row server-side.
 *
 * - `sessionId` is a client-rolled UUID stable for the lifetime of the
 *   conversation. The server uses it to find-or-create exactly one
 *   `chats` row even before any `chatId` has round-tripped back, which
 *   covers the case where two requests overlap on first turn.
 * - `chatId` is the server-assigned primary key; we adopt it as soon as
 *   we see it in streamed message metadata, and from then on every
 *   request carries it explicitly.
 * - `reset()` rolls a brand new session — used by the "New chat" button.
 *
 * `useChat` from `@ai-sdk/react` re-reads `body` on every send, so the
 * latest values returned here are picked up automatically.
 */
export function useChatSession() {
  const [sessionId, setSessionId] = useState<string>('');
  const [chatId, setChatId] = useState<number | null>(null);
  // Mirror in a ref so callers that need a synchronous read (e.g. before
  // appending) don't see stale state.
  const sessionIdRef = useRef<string>('');

  useEffect(() => {
    if (!sessionId) {
      const id = newId();
      sessionIdRef.current = id;
      setSessionId(id);
    }
  }, [sessionId]);

  const reset = useCallback(() => {
    const id = newId();
    sessionIdRef.current = id;
    setSessionId(id);
    setChatId(null);
  }, []);

  return { sessionId, chatId, setChatId, reset, sessionIdRef };
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for older runtimes; collisions effectively impossible at app scale.
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
