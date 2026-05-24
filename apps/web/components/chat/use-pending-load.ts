'use client';

import { useEffect, useRef } from 'react';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';

interface LoadedMessage {
  id: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  contentMd: string;
  parts?: Array<Record<string, unknown>> | null;
}

/**
 * If the URL has `?loadChat=<id>` we fetch that chat once on mount, hand the
 * messages + chatId to the caller, then clear the param. This is the only
 * reliable cross-render restore path — setMessages-in-place races with the
 * persistence effect and the v6 useChat hook sometimes drops the change.
 */
export function usePendingChatLoad(args: {
  onApply: (
    chatId: number,
    messages: Array<{ id: string; role: 'user' | 'assistant' | 'system'; parts: Array<Record<string, unknown>> }>,
  ) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const appliedRef = useRef(false);

  useEffect(() => {
    if (appliedRef.current) return;
    const idStr = sp?.get('loadChat');
    if (!idStr) return;
    const id = Number(idStr);
    if (!Number.isFinite(id) || id <= 0) return;
    appliedRef.current = true;
    void (async () => {
      try {
        const r = await fetch(`/api/chats/${id}`);
        if (!r.ok) return;
        const j = (await r.json()) as { messages: LoadedMessage[] };
        const ui = j.messages
          .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
          .map((m) => ({
            id: `db-${m.id}`,
            role: m.role as 'user' | 'assistant' | 'system',
            parts:
              Array.isArray(m.parts) && m.parts.length > 0
                ? (m.parts as Array<Record<string, unknown>>)
                : [{ type: 'text', text: m.contentMd } as Record<string, unknown>],
          }));
        args.onApply(id, ui);
      } finally {
        // Strip the param so a reload doesn't re-trigger.
        const params = new URLSearchParams(sp?.toString() ?? '');
        params.delete('loadChat');
        const qs = params.toString();
        router.replace((qs ? `${pathname}?${qs}` : pathname) as never);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp]);
}
