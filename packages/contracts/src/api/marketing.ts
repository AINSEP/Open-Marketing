export type MarketingPlatform =
  | 'meta'
  | 'instagram'
  | 'google_ads'
  | 'tiktok_ads'
  | 'canva'
  | 'cloudinary';

export type MarketingConnectorRole =
  | 'campaign_launch'
  | 'creative'
  | 'asset_library'
  | 'reporting'
  | 'planned';

export type MarketingConnectorStatus =
  | 'primary'
  | 'available'
  | 'connected'
  | 'read_only'
  | 'planned'
  | 'disconnected';

export type MarketingCampaignStatus =
  | 'draft'
  | 'paused'
  | 'needs_approval'
  | 'active'
  | 'reporting'
  | 'completed'
  | 'archived';

export type MarketingRecommendationPriority = 'low' | 'medium' | 'high';

export interface MarketingConnectorSummary {
  id: string;
  providerId: string;
  platform: MarketingPlatform;
  name: string;
  role: MarketingConnectorRole;
  status: MarketingConnectorStatus;
  description: string;
  isPrimary: boolean;
  connectedAccountLabel?: string;
}

export interface MarketingCampaignSummary {
  id: string;
  name: string;
  brief: string;
  status: MarketingCampaignStatus;
  channel: string;
  objective: string;
  budgetLabel: string;
  audienceLabel: string;
  nextAction: string;
  updatedAt: number;
  sample: boolean;
  primaryMetricLabel?: string;
  primaryMetricValue?: string;
}

export interface MarketingRecommendationSummary {
  id: string;
  campaignId?: string;
  priority: MarketingRecommendationPriority;
  action: string;
  rationale: string;
  status: string;
  createdAt: number;
}

export interface MarketingOverviewResponse {
  connectors: MarketingConnectorSummary[];
  sampleCampaigns: MarketingCampaignSummary[];
  recommendations: MarketingRecommendationSummary[];
}
