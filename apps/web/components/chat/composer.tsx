'use client';

import { useRef, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (text: string) => void;
  onStop?: () => void;
  isLoading?: boolean;
  disabled?: boolean;
  placeholder?: string;
}

export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  isLoading,
  disabled,
  placeholder,
}: Props) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const inputDisabled = disabled && !isLoading;

  function submit() {
    const text = value.trim();
    if (!text || isLoading) return;
    // Clear the textarea synchronously BEFORE calling onSubmit so the input
    // feels instant — even if the parent's onSubmit later updates state.
    // (Parent's submitInput also calls setInput(''), but doing it here too
    // makes the local DOM feel responsive within the same paint frame.)
    onChange('');
    onSubmit(text);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends; Shift+Enter inserts a newline. IME composition (e.g. Thai,
    // Japanese) takes priority — never submit mid-composition.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="border-t border-border bg-background px-3 py-3 sm:px-6 sm:py-4"
    >
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? 'Send a message…'}
          rows={1}
          disabled={inputDisabled}
          className={cn(
            'flex-1 resize-none rounded-md border border-border bg-background px-3 py-2 text-sm',
            'placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-foreground/30',
            'max-h-48 min-h-[40px] disabled:opacity-50',
          )}
        />
        {isLoading && onStop ? (
          <Button type="button" size="sm" variant="outline" onClick={onStop}>
            <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-foreground/70" />
            <span className="ml-2">Stop</span>
          </Button>
        ) : (
          <Button type="submit" size="sm" disabled={inputDisabled || !value.trim()}>
            Send
          </Button>
        )}
      </div>
      <div className="mx-auto mt-1 max-w-3xl text-[10px] text-muted-foreground">
        Enter to send · Shift+Enter for newline
      </div>
    </form>
  );
}
