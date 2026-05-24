import { SetupForm } from './setup-form';

export const dynamic = 'force-dynamic';

export default function SetupPage() {
  const remoteMode =
    process.env.BIND_HOST === '0.0.0.0' && !!process.env.SETUP_BEARER_HMAC_SECRET;

  if (!remoteMode) {
    return (
      <div className="mx-auto max-w-md p-8">
        <h1 className="text-lg font-semibold">Setup not required</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This instance is bound to localhost or remote-access mode is not enabled.
          No shared secret is needed.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md p-8">
      <h1 className="text-lg font-semibold">Enter access secret</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This instance is publicly reachable. Enter the shared secret configured
        on the server to unlock the app. A 90-day cookie will be set on this
        device.
      </p>
      <div className="mt-6">
        <SetupForm />
      </div>
    </div>
  );
}
