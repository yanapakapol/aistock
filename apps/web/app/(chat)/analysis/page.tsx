import { AnalysisClient } from './analysis-client';

interface PageProps {
  searchParams: Promise<{ stock?: string }>;
}

export default async function AnalysisPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const symbol = sp?.stock ?? null;
  return <AnalysisClient initialSymbol={symbol} />;
}
