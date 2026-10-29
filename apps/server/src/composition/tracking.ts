/** Tracking setup composes existing plugin tags, collector evidence and published forms. */
import { z } from 'zod';
import { campaignKeySchema, parseBoundary, trackingTagOutputSchema } from '@open-marketing/contracts';
import type { CallContext, CallOptions, CampaignKey, Outcome, TrackingTagOutput } from '@open-marketing/contracts';
import { destinationReadinessSchema, webEventInstallSource, type WebEventService } from '@open-marketing/web-events';
import type { FormsService } from '@open-marketing/forms';
import type { AccountBindingLookupPort } from '@open-marketing/workspaces';
import type { bindAgentPluginBackends } from './agent-plugin-backends.js';
import { localFailure } from './local-auth.js';
import { omConsentBanner } from '../inbound/public.js';

const destinationUrl = z.url({ protocol: /^https$/ }).max(2048).refine(value => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return !url.username && !url.password;
});
/** Owner input names campaigns only; connections are resolved from current scoped bindings.
 * consentBanner (default true) renders Jini's built-in banner; false = headless for a site's own CMP. */
export const trackingSnippetInputSchema = z.strictObject({ destinationUrl, campaignKeys: z.array(campaignKeySchema).max(2).optional(), consentBanner: z.boolean().optional() });
export const trackingSnippetOutputSchema = z.strictObject({ source: z.string(), campaignUrlTemplates: z.array(z.strictObject({ campaignKey: campaignKeySchema, template: trackingTagOutputSchema.shape.campaignUrlTemplate })).max(2),
    consentBanner: z.strictObject({ head: z.string(), body: z.string() }) });
/** Existing heartbeat evidence, with an optional published form selection; never updates campaigns. */
export const trackingReadinessInputSchema = z.strictObject({ destinationUrl, fallbackSlug: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional() });
export const trackingReadinessOutputSchema = destinationReadinessSchema.extend({ fallbackUrl: z.url({ protocol: /^https$/ }).nullable() });
type Dependencies = { host: Pick<ReturnType<typeof bindAgentPluginBackends>, 'invokeCapability'> | undefined;
    accounts: AccountBindingLookupPort; webEvents: Pick<WebEventService, 'destinationReadiness'>;
    forms: Pick<FormsService, 'renderHostedForm'>; publicOrigin?: string };

/** One call per selected key, sequentially, with server-resolved connections and no retained authority.
 * Missing host/binding and invalid plugin output are explicit failures; generated source stays inert.
 * @example bindTracking({ host, accounts, webEvents, forms, publicOrigin }).snippet({ context, destinationUrl, campaignKeys })
 * @complexity O(tags + source bytes), <=2 capability calls; readiness performs <=1 form render.
 */
export function bindTracking(required: Dependencies) {
    return {
        async snippet(input: { context: CallContext } & z.infer<typeof trackingSnippetInputSchema>, options?: CallOptions): Promise<Outcome<z.infer<typeof trackingSnippetOutputSchema>>> {
            const { context, ...request } = input;
            const parsed = parseBoundary({ schema: trackingSnippetInputSchema, input: request });
            if (!parsed.ok) return parsed;
            if (!required.host && parsed.value.campaignKeys?.length) return localFailure({ code: 'unavailable', message: 'Tracking host unavailable' });
            const tags: TrackingTagOutput[] = [];
            const campaignUrlTemplates: z.infer<typeof trackingSnippetOutputSchema>['campaignUrlTemplates'] = [];
            for (const campaignKey of parsed.value.campaignKeys ?? []) {
                const tag = await campaignTag({ ...required, context, campaignKey, destinationUrl: parsed.value.destinationUrl }, options);
                if (!tag.ok) return tag;
                tags.push(tag.value);
                campaignUrlTemplates.push({ campaignKey, template: tag.value.campaignUrlTemplate });
            }
            const source = webEventInstallSource({ collectionPath: '/c', tags });
            const consentBanner = omConsentBanner({ mode: parsed.value.consentBanner === false ? 'headless' : 'jini' });
            return source.ok ? { ok: true, value: { source: source.value, campaignUrlTemplates, consentBanner } } : source;
        },
        async readiness(input: { context: CallContext } & z.infer<typeof trackingReadinessInputSchema>, options?: CallOptions): Promise<Outcome<z.infer<typeof trackingReadinessOutputSchema>>> {
            const { context, ...request } = input;
            const parsed = parseBoundary({ schema: trackingReadinessInputSchema, input: request });
            if (!parsed.ok) return parsed;
            const readiness = await required.webEvents.destinationReadiness({ context, destinationUrl: parsed.value.destinationUrl }, options);
            if (!readiness.ok) return readiness;
            if (!parsed.value.fallbackSlug || !required.publicOrigin) return { ok: true, value: { ...readiness.value, fallbackUrl: null } };
            const rendered = await required.forms.renderHostedForm({ context, slug: parsed.value.fallbackSlug }, options);
            return { ok: true, value: { ...readiness.value, fallbackUrl: rendered.ok ? required.publicOrigin + '/f/' + parsed.value.fallbackSlug : null } };
        },
    };
}

/** Scoped binding supplies the sole connection reference; the existing host owns plugin admission. */
async function campaignTag(required: Dependencies & { context: CallContext; campaignKey: CampaignKey; destinationUrl: string }, options?: CallOptions): Promise<Outcome<TrackingTagOutput>> {
    const found = await required.accounts.find({ context: required.context, externalAccountId: required.campaignKey.accountId }, options);
    if (!found.ok) return found;
    const binding = found.value;
    if (!binding || binding.externalAccountId !== required.campaignKey.accountId || binding.scope.ownerId !== required.context.scope.ownerId
        || binding.scope.workspaceId !== required.context.scope.workspaceId) return localFailure({ code: 'forbidden', message: 'Tracking account unavailable in scope' });
    const result = await required.host!.invokeCapability({ context: required.context, pluginId: required.campaignKey.pluginId, capabilityId: 'tracking.tag.v1',
        connection: { connectionId: binding.connectionId, accountId: binding.externalAccountId }, input: { campaignKey: required.campaignKey, destinationUrl: required.destinationUrl } }, options);
    return result.ok ? parseBoundary({ schema: trackingTagOutputSchema, input: result.value }) : result;
}
