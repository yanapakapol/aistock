'use client';

import { Markdown } from './markdown';
import { ThinkingCard, type ToolChunk } from './thinking-card';
import { AnswerCard } from './answer-card';

// AI SDK v6 UI messages: `parts: [{type, text|input|output|toolName|state}]`.
export interface UIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'data';
  content?: string;
  parts?: Array<{
    type: string;
    text?: string;
    toolName?: string;
    args?: unknown;
    result?: unknown;
    input?: unknown;
    output?: unknown;
    state?: string;
  }>;
}

interface MessageBubbleProps {
  message: UIMessage;
  /** True while the entire chat session is streaming. Only meaningful for the
   * latest assistant turn — bubbles for older turns are settled. */
  streaming: boolean;
  /** True if this bubble is the most-recent message in the list. Combined with
   * `streaming` to decide whether the live indicators in the thinking card
   * stay lit, and whether the answer card auto-expands on completion. */
  isLatest: boolean;
}

/**
 * One chat bubble. User turns render a single right-aligned bubble. Assistant
 * turns split into two cards:
 *
 *   - upper THINKING card (rich, prominent) — tool calls + progress + ETA
 *   - lower ANSWER card (collapsed by default) — the final markdown text
 *
 * The thinking card is the dominant element while the model is working; the
 * answer card auto-expands once for the freshest just-finished turn.
 */
export function MessageBubble({ message, streaming, isLatest }: MessageBubbleProps) {
  const role = message.role;
  const isUser = role === 'user';

  // Flatten `message.parts` into the typed chunks both cards understand.
  // Text parts feed the AnswerCard; tool-* parts feed the ThinkingCard.
  const textParts: string[] = [];
  const toolChunks: ToolChunk[] = [];

  if (message.parts && message.parts.length > 0) {
    for (const p of message.parts) {
      if (p.type === 'text' && p.text) {
        textParts.push(p.text);
      } else if (p.type === 'reasoning' && p.text) {
        // Surface reasoning inline as italic prose so the user can still see
        // model thinking when the provider streams it separately.
        textParts.push(`_thinking:_ ${p.text}`);
      } else if (p.type === 'step-start' || p.type === 'step-finish') {
        // ignore — these are AI SDK lifecycle markers, not user-visible content
      } else if (p.type?.startsWith('tool-')) {
        const toolName = p.toolName ?? p.type.replace(/^tool-/, '');
        const args = p.input ?? p.args;
        const result = p.output ?? p.result;
        // v6 lifecycle: 'input-streaming' | 'input-available' | 'output-available' | 'output-error'
        const errored = p.state === 'output-error';
        const running =
          p.state != null
            ? p.state !== 'output-available' && p.state !== 'output-error'
            : result == null;
        toolChunks.push({
          toolName,
          toolArgs: args,
          toolResult: result,
          running,
          errored,
        });
      }
    }
  } else if (message.content) {
    textParts.push(message.content);
  }

  const fullText = textParts.join('\n\n');

  if (isUser) {
    return (
      <div className="flex w-full justify-end">
        <div className="max-w-[85%] space-y-2 rounded-lg bg-accent px-4 py-3 text-sm leading-relaxed text-foreground">
          <div className="markdown-body">
            <Markdown source={fullText} />
          </div>
        </div>
      </div>
    );
  }

  // Assistant: large thinking card on top, collapsible answer card below.
  // The thinking card "stillActive" is true while any tool is in flight; we
  // also keep it visually lit while the parent reports `streaming` and this
  // is the latest turn (covers the post-tool "model generating answer text"
  // window where chunks are settled but the LLM is still typing).
  const anyToolRunning = toolChunks.some((c) => c.running);
  const thinkingActive = anyToolRunning;
  const turnStreaming = streaming && isLatest;

  // While streaming, hide the lower card until text actually arrives. Once
  // ANY text exists, render the lower card — collapsed for older turns,
  // auto-expanded for the freshest one (handled inside AnswerCard).
  const showAnswerCard = fullText.length > 0;

  return (
    <div className="flex w-full justify-start">
      <div className="w-full space-y-3">
        {toolChunks.length > 0 ? (
          <ThinkingCard chunks={toolChunks} active={thinkingActive} streaming={turnStreaming} />
        ) : null}
        {showAnswerCard ? (
          <AnswerCard text={fullText} streaming={turnStreaming} isLatest={isLatest} />
        ) : null}
      </div>
    </div>
  );
}
