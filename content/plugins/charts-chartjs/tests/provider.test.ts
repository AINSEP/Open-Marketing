// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ChartConfiguration, TickOptions } from 'chart.js';
import { createChartProviderRegistry, type ChartSpec } from '@jini-ai/ui/charts';
import { mountChart } from '@jini-ai/ui/charts/browser';
import { ChartProviderError, mount } from '../src/provider.js';
type Config = ChartConfiguration<'line' | 'bar', number[], string>;
const vendor = vi.hoisted(() => ({ register: vi.fn(), construct: vi.fn(), update: vi.fn(), destroy: vi.fn(), instances: [] as { canvas: HTMLCanvasElement; config: Config; data: Config['data']; options: Config['options']; ctx: object | null }[] }));
vi.mock('chart.js', () => ({ Chart: class {
  config: Config; data: Config['data']; options: Config['options']; ctx: object | null = {}; update = vendor.update; destroy = vendor.destroy;
  static register = vendor.register;
  static getChart(canvas: HTMLCanvasElement) { return vendor.instances.find(chart => chart.canvas === canvas); }
  constructor(readonly canvas: HTMLCanvasElement, config: Config) {
    this.config = config; this.data = config.data; this.options = config.options;
    vendor.instances.push(this); vendor.construct(canvas, config);
  }
}, LineController: 'line', BarController: 'bar', LineElement: 'lineElement', PointElement: 'point', BarElement: 'barElement', CategoryScale: 'category', LinearScale: 'linear', Title: 'title', SubTitle: 'subtitle', Legend: 'legend', Tooltip: 'tooltip' }));
const spec = (overrides: Partial<ChartSpec> = {}): ChartSpec => ({ kind: 'line', categoryKey: 'date', series: [{ key: 'a', label: 'Visits' }, { key: 'b' }], data: [{ date: '2026-10-25', a: 0, b: 2 }, { date: '2026-10-01', a: 3, b: -1 }], ...overrides });
const theme = { mode: 'light' as const };
const element = (): HTMLDivElement => { const host = document.createElement('div'); document.body.append(host); return host; };
beforeEach(() => { vi.resetAllMocks(); vendor.instances.length = 0; document.body.replaceChildren(); });
afterEach(() => { vi.restoreAllMocks(); });

it('registers only line/bar controllers, their elements, scales and used plugins', async () => {
  vi.resetModules();
  await import('../src/provider.js');
  expect(vendor.register).toHaveBeenCalledExactlyOnceWith('line', 'bar', 'lineElement', 'point', 'barElement', 'category', 'linear', 'title', 'subtitle', 'legend', 'tooltip');
});

it.each(['line', 'bar'])('maps %s, multiple series, zero and supplied date order', kind => {
  const input = spec({ kind }); const original = JSON.stringify(input);
  const instance = mount({ element: element(), theme, spec: input });
  expect(vendor.construct.mock.lastCall![1]).toMatchObject({ type: kind,
    data: { labels: ['2026-10-25', '2026-10-01'], datasets: [{ label: 'Visits', data: [0, 3] }, { label: 'b', data: [2, -1] }] },
    options: { animation: false, responsive: true, maintainAspectRatio: false, scales: { x: { type: 'category' } } },
  });
  expect(JSON.stringify(input)).toBe(original); instance.destroy({});
});
it.each<Partial<ChartSpec>>([
  { kind: 'funnel' }, { kind: 'heatmap' }, { kind: 'pie' }, { series: [] }, { categoryKey: undefined },
  { series: Array.from({ length: 17 }, () => ({ key: 'a' })) },
  { data: [{ date: 'x', a: 1, b: null }] }, { data: [{ date: 'x', a: 1, b: '2' }] },
  { data: [{ date: 'x', a: 1, b: NaN }] }, { data: [{ date: 'x', a: 1 }] },
  { data: [{ date: true, a: 1, b: 2 }] },
  { data: Array.from({ length: 5001 }, () => ({ date: 'x', a: 1 })), series: [{ key: 'a' }] },
  { data: Array.from({ length: 2501 }, () => ({ date: 'x', a: 1, b: 2 })) },
])('rejects unsupported or mixed-invalid rows before construction: %j', overrides => {
  expect(() => mount({ element: element(), theme, spec: spec(overrides) })).toThrow(ChartProviderError);
  expect(vendor.construct).not.toHaveBeenCalled();
});
it('accepts exactly 5,000 values and 16 series', () => {
  const instance = mount({ element: element(), theme, spec: spec({ data: Array.from({ length: 2500 }, () => ({ date: 'x', a: 0, b: 2 })) }) });
  expect(vendor.instances[0]!.data.datasets[1]!.data).toHaveLength(2500);
  instance.update({ theme, spec: spec({ series: Array.from({ length: 16 }, () => ({ key: 'a' })) }) });
  expect(vendor.instances[0]!.data.datasets).toHaveLength(16); instance.destroy({});
});
it('updates kind, title, labels, colors and numeric formatting without a second canvas', () => {
  const host = element(); const instance = mount({ element: host, theme, spec: spec() });
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({ color: 'rgb(1, 2, 3)' } as CSSStyleDeclaration);
  instance.update({ spec: spec({ kind: 'bar', title: 'New', format: { locale: 'de-DE' }, axes: { y: { label: 'Count' } } }), theme: { mode: 'dark', tokens: { '--jini-chart-1': '#123456' } } });
  const chart = vendor.instances[0]!;
  expect(chart.config.type).toBe('bar');
  expect(chart.data.datasets[0]).toMatchObject({ backgroundColor: 'rgb(1, 2, 3)', borderColor: 'rgb(1, 2, 3)' });
  expect(chart.options).toMatchObject({ color: 'rgb(1, 2, 3)', plugins: { title: { text: 'New' } }, scales: { y: { title: { text: 'Count' } } } });
  const { callback } = chart.options!.scales!.y!.ticks as unknown as Pick<TickOptions, 'callback'>;
  expect(callback.call(undefined as never, 1234.5, 0, [])).toBe('1.234,5');
  expect(host.firstElementChild!.getAttribute('data-chart-theme')).toBe('dark');
  expect(vendor.construct).toHaveBeenCalledOnce(); expect(vendor.update).toHaveBeenCalledWith('none');
  instance.update({ spec: spec(), theme });
  expect((host.firstElementChild as HTMLElement).style.getPropertyValue('--jini-chart-1')).toBe(''); instance.destroy({});
});
it('only removes its own canvas and destroys once, including after update failure', () => {
  const host = element(); const existing = document.createElement('span'); host.append(existing);
  const instance = mount({ element: host, theme, spec: spec() });
  vendor.update.mockImplementationOnce(() => { throw new Error('update'); });
  expect(() => instance.update({ theme, spec: spec() })).toThrow(ChartProviderError);
  instance.destroy({}); instance.destroy({}); instance.update({ theme, spec: spec() });
  expect(vendor.destroy).toHaveBeenCalledOnce(); expect(vendor.update).toHaveBeenCalledOnce();
  expect(Array.from(host.children)).toEqual([existing]);
});
it('cleans up partial construction and leaves the real Jini fallback visible', async () => {
  vendor.construct.mockImplementationOnce(() => { throw new Error('construction'); });
  const host = element(); const registry = createChartProviderRegistry({ providers: [{ id: 'plugin.chartjs', kinds: ['line'], enabled: true, load: async () => ({ mount }) }] });
  const instance = mountChart({ element: host, spec: spec(), registry }); await instance.ready;
  expect(host.querySelector('table')!.textContent).toContain('2026-10-25');
  expect((host.querySelector('[data-chart-fallback]') as HTMLElement).hidden).toBe(false);
  expect(vendor.destroy).toHaveBeenCalledOnce(); expect(host.querySelector('canvas')).toBeNull(); instance.destroy({});
});
it('treats a missing canvas context as failure and releases the partial chart', () => {
  vendor.construct.mockImplementationOnce(() => { vendor.instances[0]!.ctx = null; });
  const host = element();
  expect(() => mount({ element: host, theme, spec: spec() })).toThrow(ChartProviderError);
  expect(vendor.destroy).toHaveBeenCalledOnce(); expect(host.childElementCount).toBe(0);
});
it('rejects unsupported updates before vendor effects and removes a failed destroy', () => {
  const host = element(); const instance = mount({ element: host, theme, spec: spec() });
  expect(() => instance.update({ theme, spec: spec({ kind: 'heatmap' }) })).toThrow(ChartProviderError);
  expect(vendor.update).not.toHaveBeenCalled();
  vendor.destroy.mockImplementationOnce(() => { throw new Error('destroy'); });
  expect(() => instance.destroy({})).toThrow(ChartProviderError);
  expect(host.childElementCount).toBe(0); instance.destroy({}); expect(vendor.destroy).toHaveBeenCalledOnce();
});
