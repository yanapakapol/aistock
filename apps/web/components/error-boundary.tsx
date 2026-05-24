'use client';

// Reusable React class component for nested error boundaries. Use to wrap any
// subtree where a throw should NOT take down the whole route — e.g. wrap a
// portfolio table or a chat message list so one bad row doesn't blank the
// page. The `fallback` is what gets rendered in place of the children when
// the boundary catches.
//
// We deliberately keep this as a class because hooks-based error boundaries
// don't exist in React 19 (you still need componentDidCatch / getDerivedStateFromError).

import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  /** Optional label included in the console.error tag for easier debugging. */
  label?: string;
  /** Optional callback when an error is caught (for custom telemetry). */
  onError?: (error: Error, info: ErrorInfo) => void;
};

type State = {
  error: Error | null;
};

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const tag = this.props.label ? `[error-boundary:${this.props.label}]` : '[error-boundary]';
    // Always log full stack so production debugging is trivial.
    // eslint-disable-next-line no-console
    console.error(tag, error, info.componentStack);
    if (this.props.onError) {
      try {
        this.props.onError(error, info);
      } catch {
        /* swallow telemetry failures so they don't mask the original error */
      }
    }
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error) {
      const { fallback } = this.props;
      if (typeof fallback === 'function') {
        return fallback(error, this.reset);
      }
      if (fallback !== undefined) {
        return fallback;
      }
      // Default fallback: small inline panel that still surfaces the message
      // and offers a reset, so we never silently render nothing.
      return (
        <div className="m-2 rounded-lg border border-red-500/40 bg-red-500/5 p-3 text-sm">
          <div className="font-semibold">Component crashed</div>
          <div className="mt-1 text-xs text-muted-foreground break-words">
            {error.message || 'Unknown error'}
          </div>
          <button
            type="button"
            onClick={this.reset}
            className="mt-2 rounded bg-foreground/10 px-2 py-0.5 text-xs hover:bg-foreground/20"
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
