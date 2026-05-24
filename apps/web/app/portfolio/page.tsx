import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { PortfolioClient } from './portfolio-client';

// Force-dynamic so the auth check below runs per request (no static render
// could ever inline a logged-in user's portfolio anyway, but be explicit).
export const dynamic = 'force-dynamic';

export default async function PortfolioPage() {
  // Defence-in-depth: middleware already redirects unauthenticated requests
  // to /login, but if the session cookie somehow exists yet `getCurrentUser`
  // can't resolve it (e.g. stale cookie after a DB wipe, or a guest whose
  // row was expired/deleted), we'd previously render the client which would
  // then 401 on every fetch with no recovery path. Redirect explicitly.
  const me = await getCurrentUser().catch(() => null);
  if (!me) redirect('/login?next=/portfolio');

  return (
    <div className="h-full overflow-hidden">
      <PortfolioClient />
    </div>
  );
}
