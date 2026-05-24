'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { urlBase64ToUint8Array } from './push-toggle-helpers';

type Status =
  | 'idle'
  | 'unsupported'
  | 'denied'
  | 'subscribing'
  | 'subscribed'
  | 'unsubscribing'
  | 'error';

interface State {
  status: Status;
  message?: string;
}

/**
 * Small toolbar button that toggles Web Push for this browser. On click:
 *   1. Asks for notification permission (if not already granted/denied).
 *   2. Waits for the SW to be ready, reuses an existing PushSubscription or
 *      creates one with the server's VAPID public key.
 *   3. POSTs the subscription JSON to /api/push/subscribe.
 * Disable does the inverse: unsubscribes locally and POSTs the endpoint to
 * /api/push/unsubscribe so the server soft-disables the row.
 *
 * iOS 16.4+ caveat: push only works when the PWA is installed to the home
 * screen. In Safari tab, `Notification` exists but `pushManager.subscribe`
 * throws — surfaced here as an error message under the button.
 */
export function PushToggle() {
  const [state, setState] = useState<State>({ status: 'idle' });

  // Detect support + read current subscription on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (typeof window === 'undefined') return;
      if (
        !('serviceWorker' in navigator) ||
        !('PushManager' in window) ||
        !('Notification' in window)
      ) {
        if (!cancelled) setState({ status: 'unsupported', message: 'Push not supported in this browser.' });
        return;
      }
      if (Notification.permission === 'denied') {
        if (!cancelled) setState({ status: 'denied', message: 'Blocked in browser settings.' });
        return;
      }
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!cancelled) {
          setState({ status: sub ? 'subscribed' : 'idle' });
        }
      } catch {
        if (!cancelled) setState({ status: 'idle' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = useCallback(async () => {
    setState({ status: 'subscribing' });
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setState({ status: 'denied', message: 'Permission not granted.' });
        return;
      }

      const reg = await navigator.serviceWorker.ready;

      // Fetch the public key fresh each time — the server may rotate it and
      // we don't want a stale cached key.
      const keyRes = await fetch('/api/push/vapid-public-key');
      const keyJson = (await keyRes.json()) as { key?: string };
      if (!keyJson.key) {
        setState({ status: 'error', message: 'Server VAPID key not configured.' });
        return;
      }

      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(keyJson.key) as BufferSource,
        });
      }

      const res = await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!res.ok) {
        setState({ status: 'error', message: `Server rejected subscription (${res.status}).` });
        return;
      }
      setState({ status: 'subscribed' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState({ status: 'error', message: msg });
    }
  }, []);

  const disable = useCallback(async () => {
    setState({ status: 'unsubscribing' });
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe().catch(() => {});
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint }),
        }).catch(() => {});
      }
      setState({ status: 'idle' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState({ status: 'error', message: msg });
    }
  }, []);

  const { status, message } = state;
  const busy = status === 'subscribing' || status === 'unsubscribing';
  const subscribed = status === 'subscribed';
  const disabled = busy || status === 'unsupported' || status === 'denied';

  const label =
    status === 'unsubscribing'
      ? 'Disabling…'
      : subscribed
        ? 'Notifications on'
        : status === 'subscribing'
          ? 'Enabling…'
          : 'Enable notifications';

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant={subscribed ? 'outline' : 'default'}
        onClick={subscribed ? disable : enable}
        disabled={disabled}
        title={subscribed ? 'Disable push notifications on this device' : 'Enable push notifications on this device'}
      >
        {label}
      </Button>
      {message ? (
        <span className="text-[11px] text-muted-foreground" role="status">
          {message}
        </span>
      ) : null}
    </div>
  );
}
