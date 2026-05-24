import { getStockById } from '@/lib/portfolio/queries';
import { ResearchClient } from './research-client';

interface Props {
  searchParams: Promise<{ stock?: string }>;
}

export default async function ResearchPage({ searchParams }: Props) {
  const sp = await searchParams;
  const stockIdNum = sp.stock ? Number(sp.stock) : NaN;
  const stock =
    Number.isFinite(stockIdNum) && stockIdNum > 0
      ? await getStockById(stockIdNum)
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
