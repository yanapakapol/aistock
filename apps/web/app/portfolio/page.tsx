import { PortfolioClient } from './portfolio-client';

export const dynamic = 'force-dynamic';

export default function PortfolioPage() {
  return (
    <div className="h-full overflow-hidden">
      <PortfolioClient />
    </div>
  );
}
