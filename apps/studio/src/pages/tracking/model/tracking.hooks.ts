/** Tracking setup uses the shared tool transport; all generated code stays inert text. */
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { z } from 'zod';
import { campaignKeySchema, epochSchema, parseBoundary } from '@open-marketing/contracts';
import type { Outcome, ToolCall } from '@open-marketing/contracts';
import type { StudioApiPort, StudioRuntime } from '../../../shared/api/index.js';

const destinationSchema = z.url({ protocol: /^https$/ }).max(2048);
const campaignKeysSchema = z.array(campaignKeySchema).max(2);
const setupOutputSchema = z.strictObject({ source: z.string().max(64512), campaignUrlTemplates: z.array(z.strictObject({ campaignKey: campaignKeySchema, template: z.string().max(4096) })).max(2),
  consentBanner: z.strictObject({ head: z.string().max(65536), body: z.string().max(65536) }) });
const readinessSchema = z.strictObject({ status: z.enum(['missing', 'stale', 'ready']), heartbeatAt: epochSchema.nullable(), fallbackUrl: z.url({ protocol: /^https$/ }).nullable() });
export type TrackingTemplate = z.infer<typeof setupOutputSchema>['campaignUrlTemplates'][number];
export type TrackingProps = { api: StudioApiPort; runtime: StudioRuntime };

/** JSON is only an optional bounded CampaignKey input, never a connection or executable code. */
function setupInput(required: { destinationUrl: string; campaignKeys: string; consentBanner: boolean }) {
  try {
    return parseBoundary({ schema: z.strictObject({ destinationUrl: destinationSchema, campaignKeys: campaignKeysSchema, consentBanner: z.boolean() }),
      input: { destinationUrl: required.destinationUrl, campaignKeys: JSON.parse(required.campaignKeys || '[]'), consentBanner: required.consentBanner } });
  } catch { return unavailable({ message: 'Enter a destination and up to two campaign keys as JSON.' }); }
}
function unavailable(required: { message: string }): Outcome<never> {
  return { ok: false, error: { code: 'unavailable', message: required.message, retryable: false } };
}

/** One bounded tool request; runtime supplies cancellation, IDs and deadline. No polling/retry. */
async function trackingCall(required: TrackingProps & { name: string; input: ToolCall['input']; controller: AbortController }): Promise<Outcome<unknown>> {
  const { controller, runtime } = required;
  const handle = runtime.timers.schedule({ delayMs: 25000, callback: () => controller.abort() });
  try {
    const result = await required.api.tool?.({ call: { name: required.name, input: required.input, operationId: runtime.ids.next({}) }, signal: controller.signal });
    if (!result?.ok || result.value.status !== 'completed') return unavailable({ message: 'Tracking request unavailable. Check connections and try again.' });
    return { ok: true, value: result.value.output };
  } catch { return unavailable({ message: 'Tracking request unavailable.' }); }
  finally { runtime.timers.cancel({ handle }); }
}

/** Form state and visitor-install text; editing inputs discards previous evidence.
 * @example useTracking({ api, runtime })
 * @complexity <=2 campaign keys and one bounded tool request per action, no background work.
 */
export function useTracking(required: TrackingProps) {
  const [destinationUrl, setDestination] = useState('');
  const [campaignKeys, setCampaignKeys] = useState('');
  const [fallbackSlug, setFallback] = useState('');
  const [consentBanner, setConsentBanner] = useState(true);
  const [setup, setSetup] = useState<z.infer<typeof setupOutputSchema> | null>(null);
  const [readiness, setReadiness] = useState<z.infer<typeof readinessSchema> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); }, []);
  const request = async (input: { name: string; input: ToolCall['input'] }) => {
    if (active.current) return unavailable({ message: 'A tracking request is already running.' });
    const controller = required.runtime.abort();
    active.current = controller;
    setBusy(true); setError('');
    try {
      const result = await trackingCall({ ...required, ...input, controller });
      if (controller.signal.aborted) return unavailable({ message: 'Tracking request cancelled or timed out.' });
      return result;
    } finally { active.current = null; setBusy(false); }
  };
  const generate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSetup(null);
    const input = setupInput({ destinationUrl, campaignKeys, consentBanner });
    if (!input.ok) { setError('Enter an HTTPS destination and up to two valid campaign keys.'); return; }
    const result = await request({ name: 'om_web_events_snippet', input: input.value });
    const parsed = result.ok ? setupOutputSchema.safeParse(result.value) : null;
    if (!parsed?.success) { setError('Could not generate tracking setup. Check the destination and connected accounts.'); return; }
    setSetup(parsed.data);
  };
  const checkReadiness = async () => {
    setReadiness(null);
    const input = z.strictObject({ destinationUrl: destinationSchema, fallbackSlug: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional() }).safeParse({ destinationUrl, fallbackSlug: fallbackSlug || undefined });
    if (!input.success) { setError('Enter an HTTPS destination and a valid optional form slug.'); return; }
    const result = await request({ name: 'om_tracking_readiness', input: input.data });
    const parsed = result.ok ? readinessSchema.safeParse(result.value) : null;
    if (!parsed?.success) { setError('Could not check tracking readiness.'); return; }
    setReadiness(parsed.data);
  };
  const changeDestination = (event: ChangeEvent<HTMLInputElement>) => { setDestination(event.target.value); setSetup(null); setReadiness(null); };
  const changeKeys = (event: ChangeEvent<HTMLTextAreaElement>) => { setCampaignKeys(event.target.value); setSetup(null); };
  const changeConsentBanner = (event: ChangeEvent<HTMLInputElement>) => { setConsentBanner(event.target.checked); setSetup(null); };
  const changeFallback = (event: ChangeEvent<HTMLInputElement>) => { setFallback(event.target.value); setReadiness(null); };
  const selectSource = () => { sourceRef.current?.focus(); sourceRef.current?.select(); };
  const selectFallback = () => { if (readiness?.fallbackUrl) { setDestination(readiness.fallbackUrl); setSetup(null); setReadiness(null); } };
  return { destinationUrl, campaignKeys, fallbackSlug, consentBanner, setup, readiness, busy, error, sourceRef,
    generate, checkReadiness, changeDestination, changeKeys, changeConsentBanner, changeFallback, selectSource, selectFallback };
}
