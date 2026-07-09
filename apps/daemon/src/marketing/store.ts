import type Database from 'better-sqlite3';
import type {
  MarketingCampaignStatus,
  MarketingConnectorRole,
  MarketingConnectorStatus,
  MarketingOverviewResponse,
  MarketingPlatform,
  MarketingRecommendationPriority,
} from '@open-design/contracts';

type SqliteDatabase = Database.Database;

interface ConnectorRow {
  id: string;
  provider_id: string;
  platform: MarketingPlatform;
  name: string;
  role: MarketingConnectorRole;
  status: MarketingConnectorStatus;
  description: string;
  is_primary: number;
  connected_account_label: string | null;
}

interface CampaignRow {
  id: string;
  name: string;
  brief: string;
  status: MarketingCampaignStatus;
  channel: string;
  objective: string;
  budget_label: string | null;
  audience_label: string | null;
  next_action: string | null;
  updated_at: number;
  sample: number;
  primary_metric_label: string | null;
  primary_metric_value: string | null;
}

interface RecommendationRow {
  id: string;
  campaign_id: string | null;
  priority: MarketingRecommendationPriority;
  action: string;
  rationale: string;
  status: string;
  created_at: number;
}

const DEFAULT_CONNECTORS = [
  {
    id: 'meta-ads',
    providerId: 'meta',
    platform: 'meta',
    name: 'Meta Ads',
    role: 'campaign_launch',
    status: 'primary',
    description: 'Create paused Meta and Instagram campaign drafts, then pull performance back into Open Marketing.',
    isPrimary: 1,
  },
  {
    id: 'instagram',
    providerId: 'instagram',
    platform: 'instagram',
    name: 'Instagram',
    role: 'campaign_launch',
    status: 'available',
    description: 'Instagram placements ride through the Meta Ads connector for the first launch workflow.',
    isPrimary: 0,
  },
  {
    id: 'google-ads',
    providerId: 'google_ads',
    platform: 'google_ads',
    name: 'Google Ads',
    role: 'reporting',
    status: 'read_only',
    description: 'Read-only reporting and cross-channel analysis while campaign launch stays Meta-first.',
    isPrimary: 0,
  },
  {
    id: 'tiktok-ads',
    providerId: 'tiktok_ads',
    platform: 'tiktok_ads',
    name: 'TikTok Ads',
    role: 'planned',
    status: 'planned',
    description: 'Planned after the Meta campaign and creative workflow is stable.',
    isPrimary: 0,
  },
  {
    id: 'canva',
    providerId: 'canva',
    platform: 'canva',
    name: 'Canva',
    role: 'creative',
    status: 'available',
    description: 'Generate, edit, and export editable creative variants for campaigns.',
    isPrimary: 0,
  },
  {
    id: 'cloudinary',
    providerId: 'cloudinary',
    platform: 'cloudinary',
    name: 'Cloudinary',
    role: 'asset_library',
    status: 'available',
    description: 'Store normalized creative assets with provenance, tags, and usage rights.',
    isPrimary: 0,
  },
] as const;

const SAMPLE_CAMPAIGNS = [
  {
    id: 'sample-la-beta-launch',
    briefId: 'brief-la-beta-launch',
    name: 'LA Beta Launch',
    brief: 'Get beta users for a dating app in Los Angeles.',
    status: 'needs_approval',
    channel: 'Meta + Instagram',
    objective: 'Lead generation',
    budgetLabel: '$50/day',
    audienceLabel: 'Los Angeles singles, 24-38',
    nextAction: 'Approve the paused Meta/Instagram draft.',
    primaryMetricLabel: 'Variants',
    primaryMetricValue: '5',
  },
  {
    id: 'sample-founder-newsletter',
    briefId: 'brief-founder-newsletter',
    name: 'Founder Newsletter Test',
    brief: 'Validate a weekly founder growth newsletter.',
    status: 'draft',
    channel: 'Instagram Reels',
    objective: 'Newsletter signups',
    budgetLabel: '$30/day',
    audienceLabel: 'US founders and operators',
    nextAction: 'Review creative variants before ad-set drafting.',
    primaryMetricLabel: 'Assets',
    primaryMetricValue: '3',
  },
  {
    id: 'sample-search-intent-report',
    briefId: 'brief-search-intent-report',
    name: 'Search Intent Report',
    brief: 'Use Google intent data to refine Meta campaign angles.',
    status: 'reporting',
    channel: 'Google Ads',
    objective: 'Cross-channel insight',
    budgetLabel: 'Read-only',
    audienceLabel: 'High-intent search traffic',
    nextAction: 'Translate top search themes into Meta copy tests.',
    primaryMetricLabel: 'CTR',
    primaryMetricValue: '4.1%',
  },
] as const;

export function migrateMarketing(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS marketing_connectors (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      status TEXT NOT NULL,
      description TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      connected_account_label TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS marketing_brand_kits (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      name TEXT NOT NULL,
      voice_json TEXT,
      colors_json TEXT,
      fonts_json TEXT,
      assets_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS marketing_campaign_briefs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      offer TEXT,
      landing_page_url TEXT,
      budget_label TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      source_prompt TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS marketing_audiences (
      id TEXT PRIMARY KEY,
      brief_id TEXT REFERENCES marketing_campaign_briefs(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      locations_json TEXT,
      interests_json TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS marketing_assets (
      id TEXT PRIMARY KEY,
      source_provider TEXT NOT NULL,
      source_url TEXT,
      license TEXT,
      creator TEXT,
      file_type TEXT NOT NULL,
      dimensions TEXT,
      duration_ms INTEGER,
      tags_json TEXT,
      brand_safety_status TEXT NOT NULL DEFAULT 'unknown',
      usage_rights TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS marketing_campaigns (
      id TEXT PRIMARY KEY,
      brief_id TEXT REFERENCES marketing_campaign_briefs(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      channel TEXT NOT NULL,
      objective TEXT NOT NULL,
      budget_label TEXT,
      audience_label TEXT,
      next_action TEXT,
      sample INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS marketing_creative_variants (
      id TEXT PRIMARY KEY,
      campaign_id TEXT REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
      asset_id TEXT REFERENCES marketing_assets(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      format TEXT NOT NULL,
      headline TEXT,
      primary_text TEXT,
      cta TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS marketing_ad_sets (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      budget_label TEXT,
      targeting_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS marketing_ads (
      id TEXT PRIMARY KEY,
      ad_set_id TEXT NOT NULL REFERENCES marketing_ad_sets(id) ON DELETE CASCADE,
      creative_variant_id TEXT REFERENCES marketing_creative_variants(id) ON DELETE SET NULL,
      platform TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'paused',
      external_id TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS marketing_approvals (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_by TEXT,
      approved_by TEXT,
      note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS marketing_performance_snapshots (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      spend_cents INTEGER NOT NULL DEFAULT 0,
      impressions INTEGER NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0,
      conversions INTEGER NOT NULL DEFAULT 0,
      ctr REAL,
      cpc_cents INTEGER,
      cpa_cents INTEGER,
      roas REAL,
      captured_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS marketing_optimization_recommendations (
      id TEXT PRIMARY KEY,
      campaign_id TEXT REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
      priority TEXT NOT NULL,
      action TEXT NOT NULL,
      rationale TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_status ON marketing_campaigns(status);
    CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_sample ON marketing_campaigns(sample);
    CREATE INDEX IF NOT EXISTS idx_marketing_recommendations_status ON marketing_optimization_recommendations(status);
  `);

  seedMarketingDefaults(db);
}

export function getMarketingOverview(db: SqliteDatabase): MarketingOverviewResponse {
  seedMarketingDefaults(db);

  const connectors = db
    .prepare(
      `SELECT id, provider_id, platform, name, role, status, description, is_primary, connected_account_label
       FROM marketing_connectors
       ORDER BY is_primary DESC, name ASC`,
    )
    .all() as ConnectorRow[];

  const campaigns = db
    .prepare(
      `SELECT
         campaign.id,
         campaign.name,
         brief.goal AS brief,
         campaign.status,
         campaign.channel,
         campaign.objective,
         campaign.budget_label,
         campaign.audience_label,
         campaign.next_action,
         campaign.updated_at,
         campaign.sample,
         json_extract(campaign.metadata_json, '$.primaryMetricLabel') AS primary_metric_label,
         json_extract(campaign.metadata_json, '$.primaryMetricValue') AS primary_metric_value
       FROM marketing_campaigns campaign
       LEFT JOIN marketing_campaign_briefs brief ON brief.id = campaign.brief_id
       WHERE campaign.sample = 1
       ORDER BY campaign.updated_at DESC
       LIMIT 6`,
    )
    .all() as CampaignRow[];

  const recommendations = db
    .prepare(
      `SELECT id, campaign_id, priority, action, rationale, status, created_at
       FROM marketing_optimization_recommendations
       WHERE status = 'open'
       ORDER BY created_at DESC
       LIMIT 4`,
    )
    .all() as RecommendationRow[];

  return {
    connectors: connectors.map((connector) => ({
      id: connector.id,
      providerId: connector.provider_id,
      platform: connector.platform,
      name: connector.name,
      role: connector.role,
      status: connector.status,
      description: connector.description,
      isPrimary: connector.is_primary === 1,
      ...(connector.connected_account_label ? { connectedAccountLabel: connector.connected_account_label } : {}),
    })),
    sampleCampaigns: campaigns.map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      brief: campaign.brief,
      status: campaign.status,
      channel: campaign.channel,
      objective: campaign.objective,
      budgetLabel: campaign.budget_label ?? '',
      audienceLabel: campaign.audience_label ?? '',
      nextAction: campaign.next_action ?? '',
      updatedAt: campaign.updated_at,
      sample: campaign.sample === 1,
      ...(campaign.primary_metric_label ? { primaryMetricLabel: campaign.primary_metric_label } : {}),
      ...(campaign.primary_metric_value ? { primaryMetricValue: campaign.primary_metric_value } : {}),
    })),
    recommendations: recommendations.map((recommendation) => ({
      id: recommendation.id,
      ...(recommendation.campaign_id ? { campaignId: recommendation.campaign_id } : {}),
      priority: recommendation.priority,
      action: recommendation.action,
      rationale: recommendation.rationale,
      status: recommendation.status,
      createdAt: recommendation.created_at,
    })),
  };
}

function seedMarketingDefaults(db: SqliteDatabase): void {
  const now = Date.now();
  const insertConnector = db.prepare(`
    INSERT OR IGNORE INTO marketing_connectors (
      id, provider_id, platform, name, role, status, description, is_primary, created_at, updated_at
    ) VALUES (
      @id, @providerId, @platform, @name, @role, @status, @description, @isPrimary, @createdAt, @updatedAt
    )
  `);

  const insertBrief = db.prepare(`
    INSERT OR IGNORE INTO marketing_campaign_briefs (
      id, title, goal, budget_label, status, source_prompt, created_at, updated_at
    ) VALUES (
      @id, @title, @goal, @budgetLabel, 'draft', @sourcePrompt, @createdAt, @updatedAt
    )
  `);

  const insertCampaign = db.prepare(`
    INSERT OR IGNORE INTO marketing_campaigns (
      id, brief_id, name, status, channel, objective, budget_label, audience_label, next_action,
      sample, metadata_json, created_at, updated_at
    ) VALUES (
      @id, @briefId, @name, @status, @channel, @objective, @budgetLabel, @audienceLabel, @nextAction,
      1, @metadataJson, @createdAt, @updatedAt
    )
  `);

  const insertRecommendation = db.prepare(`
    INSERT OR IGNORE INTO marketing_optimization_recommendations (
      id, campaign_id, priority, action, rationale, status, created_at, updated_at
    ) VALUES (
      @id, @campaignId, @priority, @action, @rationale, 'open', @createdAt, @updatedAt
    )
  `);

  const seed = db.transaction(() => {
    for (const connector of DEFAULT_CONNECTORS) {
      insertConnector.run({ ...connector, createdAt: now, updatedAt: now });
    }

    for (const campaign of SAMPLE_CAMPAIGNS) {
      insertBrief.run({
        id: campaign.briefId,
        title: campaign.name,
        goal: campaign.brief,
        budgetLabel: campaign.budgetLabel,
        sourcePrompt: campaign.brief,
        createdAt: now,
        updatedAt: now,
      });
      insertCampaign.run({
        ...campaign,
        metadataJson: JSON.stringify({
          primaryMetricLabel: campaign.primaryMetricLabel,
          primaryMetricValue: campaign.primaryMetricValue,
        }),
        createdAt: now,
        updatedAt: now,
      });
    }

    insertRecommendation.run({
      id: 'sample-approval-gate',
      campaignId: 'sample-la-beta-launch',
      priority: 'high',
      action: 'Keep spend approval explicit before launch.',
      rationale: 'The first Meta/Instagram workflow should draft campaigns paused and require a human to approve spend.',
      createdAt: now,
      updatedAt: now,
    });
  });

  seed();
}
