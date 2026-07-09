import type { MarketingOverviewResponse } from '@open-design/contracts';

export async function fetchMarketingOverview(): Promise<MarketingOverviewResponse | null> {
  const response = await fetch('/api/marketing/overview', { cache: 'no-store' });
  if (!response.ok) return null;
  return await response.json() as MarketingOverviewResponse;
}
