'use client';

import { useMemo } from 'react';

interface MessageWithMaybeMetadata {
  role?: string;
  metadata?: {
    tokensIn?: number;
    tokensOut?: number;
    costUsd?: number;
    usage?: { inputTokens?: number; outputTokens?: number; promptTokens?: number; completionTokens?: number };
  } | null;
}

/**
 * Aggregates per-message metadata streamed from the chat route (via
 * `messageMetadata` in `toUIMessageStreamResponse`). Falls back to zeros while
 * a turn is in flight — the route only emits final usage in `onFinish`, so the
 * pill updates once the stream completes.
 */
export function useChatCost(messages: unknown[]) {
  return useMemo(() => {
    let tokensIn = 0;
    let tokensOut = 0;
    let usd = 0;
    for (const raw of messages) {
      const m = raw as MessageWithMaybeMetadata;
      const md = m?.metadata;
      if (!md) continue;
      tokensIn += md.tokensIn ?? md.usage?.inputTokens ?? md.usage?.promptTokens ?? 0;
      tokensOut += md.tokensOut ?? md.usage?.outputTokens ?? md.usage?.completionTokens ?? 0;
      usd += md.costUsd ?? 0;
    }
    return { tokensIn, tokensOut, usd };
  }, [messages]);
}
