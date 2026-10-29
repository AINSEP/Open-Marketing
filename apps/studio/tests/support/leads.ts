import { vi } from 'vitest';
import { createSampleStudioApi } from '../../src/shared/api/index.js';
import type { StudioApiPort } from '../../src/shared/api/index.js';
import type { LeadDisplay } from '../../src/shared/api/validation.js';
import { testRuntime } from './runtime.js';

export const unattributed: LeadDisplay = { leadId: 'lead-1', source: { kind: 'form', ref: 'submission-1' },
  stage: 'new', revision: 1, erased: false, attribution: { campaign: null } };
const paid: LeadDisplay = { ...unattributed, leadId: 'lead-2', source: { kind: 'manual', ref: 'enquiry-2' },
  attribution: { campaign: { pluginId: 'fixture-ads', accountId: 'fixture-account', vendorCampaignId: 'paid-campaign' } } };

/** Real sample API supplies unrelated methods; the only fixtures are lead transport outcomes. */
export function fixture(required: { items?: LeadDisplay[]; conflict?: boolean } = {}) {
  const host = testRuntime();
  let items = required.items ?? [unattributed, paid];
  const tool: NonNullable<StudioApiPort['tool']> = vi.fn(async () => ({ ok: true as const, value: { status: 'completed' as const, output: { items, cursor: null } } }));
  const setLeadStage: NonNullable<StudioApiPort['setLeadStage']> = vi.fn(async (input: Parameters<NonNullable<StudioApiPort['setLeadStage']>>[0]) => {
    if (required.conflict) {
      items = [{ ...unattributed, stage: 'won', revision: 2 }];
      return { ok: false as const, error: { code: 'conflict' as const, message: 'Changed', retryable: false } };
    }
    const lead = { ...unattributed, stage: input.request.to, revision: input.request.expectedRevision + 1 };
    return { ok: true as const, value: lead };
  });
  const api = { ...createSampleStudioApi({ runtime: host.runtime }), tool, setLeadStage };
  return { host, api, tool, setLeadStage };
}

