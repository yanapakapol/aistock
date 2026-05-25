import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { PickerClient } from './picker-client';

// Force-dynamic so the per-request auth check below actually runs. The page
// renders nothing useful for an anonymous viewer (the only thing here is a
// signed-in 3-step picker flow), so static prerendering would be wasted work
// at best and a leak risk at worst.
export const dynamic = 'force-dynamic';

export default async function PickerPage() {
  // Belt-and-braces alongside middleware: a stale cookie whose user row no
  // longer exists in Postgres should bounce to /login instead of rendering
  // the client and watching every fetch 401.
  const me = await getCurrentUser().catch(() => null);
  if (!me) redirect('/login?next=/picker');

  return (
    <div className="h-full overflow-hidden">
      <PickerClient />
    </div>
  );
}
