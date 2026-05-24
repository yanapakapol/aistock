import { redirect } from 'next/navigation';
import { getStockById } from '@/lib/portfolio/queries';
import { getCurrentUser } from '@/lib/auth/session';
import { ResearchClient } from './research-client';

interface Props {
  searchParams: Promise<{ stock?: string }>;
}

export default async function ResearchPage({ searchParams }: Props) {
  const me = await getCurrentUser().catch(() => null);
  if (!me) redirect('/login?next=/research');

  const sp = await searchParams;
  const stockIdNum = sp.stock ? Number(sp.stock) : NaN;
  // Only resolves if the stock belongs to the calling user; otherwise null
  // (the page renders the empty state instead of leaking another user's stock).
  const stock =
    Number.isFinite(stockIdNum) && stockIdNum > 0
      ? await getStockById(stockIdNum, me.id)
      : null;

  return (
    <ResearchClient
      stock={
        stock
          ? {
              id: stock.id,
              symbol: stock.symbol,
              exchange: stock.exchange,
              name: stock.name,
            }
          : null
      }
    />
  );
}
