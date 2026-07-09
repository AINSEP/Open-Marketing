// In-memory campaign store for the Open Marketing ag-ui agent.
//
// The original Open-Marketing-old kept campaigns in its own SQLite-backed
// `@open-marketing/db` package. That conflicts with Open Design's
// better-sqlite3 data layer, so for the layered ag-ui port we keep a small
// process-local store. Campaigns live for the daemon's lifetime; persistence
// can be reintroduced later by backing these functions with the OD db.

import { randomUUID } from 'node:crypto';

export type CampaignStatus = 'draft' | 'active' | 'completed' | 'archived';

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  pendingPrompt: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateCampaignInput {
  name: string;
  status?: CampaignStatus;
  pendingPrompt?: string | null;
}

const campaigns = new Map<string, Campaign>();

export async function listCampaigns(): Promise<Campaign[]> {
  return [...campaigns.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getCampaign(id: string): Promise<Campaign | null> {
  return campaigns.get(id) ?? null;
}

export async function createCampaign(input: CreateCampaignInput): Promise<Campaign> {
  const now = Date.now();
  const campaign: Campaign = {
    id: randomUUID(),
    name: input.name,
    status: input.status ?? 'draft',
    pendingPrompt: input.pendingPrompt ?? null,
    createdAt: now,
    updatedAt: now,
  };
  campaigns.set(campaign.id, campaign);
  return campaign;
}
