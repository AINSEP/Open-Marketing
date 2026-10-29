/** @vitest-environment jsdom */
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TrackingPage } from '../src/pages/tracking/index.js';
import { createSampleStudioApi } from '../src/shared/api/index.js';
import type { StudioApiPort } from '../src/shared/api/index.js';
import { testRuntime } from './support/runtime.js';

afterEach(cleanup);

it('generates inert setup, selects source for native copy, checks missing/stale/ready and chooses the published fallback', async () => {
  const host = testRuntime();
  const sample = createSampleStudioApi({ runtime: host.runtime });
  const source = '<script>window.mustNotExecute = true;</script>';
  let status: 'missing' | 'stale' | 'ready' = 'missing';
  const snippet = { source, campaignUrlTemplates: [{ campaignKey: { pluginId: 'fixture', accountId: 'a', vendorCampaignId: 'c' }, template: 'https://site.example/?id={campaign}' }],
    consentBanner: { head: '<script src="/consent/client.min.js"></script>', body: '<div id="jini-consent"></div>' } };
  const readiness = () => ({ status, heartbeatAt: status === 'missing' ? null : 1000, fallbackUrl: 'https://public.example/f/lead' });
  const tool: NonNullable<StudioApiPort['tool']> = vi.fn(async (input: Parameters<NonNullable<StudioApiPort['tool']>>[0]) => ({ ok: true as const, value: { status: 'completed' as const,
    output: input.call.name === 'om_web_events_snippet' ? snippet : readiness() } }));
  render(createElement(TrackingPage, { api: { ...sample, tool }, runtime: host.runtime }));
  fireEvent.change(screen.getByLabelText('Destination URL'), { target: { value: 'https://site.example/landing' } });
  fireEvent.click(screen.getByRole('button', { name: 'Generate setup' }));
  const output = await screen.findByLabelText('Installation source') as HTMLTextAreaElement;
  expect(output.value).toBe(source);
  expect(tool).toHaveBeenLastCalledWith(expect.objectContaining({ call: expect.objectContaining({ name: 'om_web_events_snippet', input: { destinationUrl: 'https://site.example/landing', campaignKeys: [], consentBanner: true } }) }));
  expect((screen.getByLabelText('Consent banner head (put in <head>)') as HTMLTextAreaElement).value).toBe(snippet.consentBanner.head);
  expect((screen.getByLabelText('Consent banner body (put before </body>)') as HTMLTextAreaElement).value).toBe(snippet.consentBanner.body);
  expect(document.querySelector('script')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Select source to copy' }));
  expect(output.selectionStart).toBe(0);
  expect(output.selectionEnd).toBe(source.length);
  expect(screen.getByText('https://site.example/?id={campaign}')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Fallback form slug (optional)'), { target: { value: 'lead' } });
  for (const next of ['missing', 'stale', 'ready'] as const) {
    status = next;
    fireEvent.click(screen.getByRole('button', { name: 'Check readiness' }));
    await screen.findByText('Collector: ' + next);
  }
  expect(tool).toHaveBeenLastCalledWith(expect.objectContaining({ call: expect.objectContaining({ name: 'om_tracking_readiness', input: { destinationUrl: 'https://site.example/landing', fallbackSlug: 'lead' } }) }));
  expect(screen.getByRole('link', { name: 'https://public.example/f/lead' }).getAttribute('href')).toBe('https://public.example/f/lead');
  fireEvent.click(screen.getByRole('button', { name: 'Use hosted form' }));
  expect((screen.getByLabelText('Destination URL') as HTMLInputElement).value).toBe('https://public.example/f/lead');
  expect(screen.queryByLabelText('Installation source')).toBeNull();
  expect(screen.queryByText('Collector: ready')).toBeNull();
  await waitFor(() => expect(host.pending()).toBe(0));
});

it('sends consentBanner false for a site with its own consent manager', async () => {
  const host = testRuntime();
  const sample = createSampleStudioApi({ runtime: host.runtime });
  const output = { source: 'inert', campaignUrlTemplates: [], consentBanner: { head: '<script></script>', body: '' } };
  const tool: NonNullable<StudioApiPort['tool']> = vi.fn(async () => ({ ok: true as const, value: { status: 'completed' as const, output } }));
  render(createElement(TrackingPage, { api: { ...sample, tool }, runtime: host.runtime }));
  fireEvent.change(screen.getByLabelText('Destination URL'), { target: { value: 'https://site.example/landing' } });
  fireEvent.click(screen.getByLabelText(/Show OM consent banner/));
  fireEvent.click(screen.getByRole('button', { name: 'Generate setup' }));
  await screen.findByLabelText('Installation source');
  expect(tool).toHaveBeenCalledWith(expect.objectContaining({ call: expect.objectContaining({ input: { destinationUrl: 'https://site.example/landing', campaignKeys: [], consentBanner: false } }) }));
  await waitFor(() => expect(host.pending()).toBe(0));
});
