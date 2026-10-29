// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createChartProviderRegistry, type ChartSpec } from '@jini-ai/ui/charts';
import { mountChart } from '@jini-ai/ui/charts/browser';
import { ChartProviderError, mount } from '../src/provider.js';

const vendor = vi.hoisted(() => ({ use: vi.fn(), init: vi.fn(), getInstanceByDom: vi.fn(), setOption: vi.fn(), dispose: vi.fn(), resize: vi.fn(), observe: vi.fn(), disconnect: vi.fn(), resized: undefined as (() => void) | undefined }));
vi.mock('echarts/core', () => ({ use: vendor.use, init: vendor.init, getInstanceByDom: vendor.getInstanceByDom }));
vi.mock('echarts/charts', () => ({ LineChart: 'line', BarChart: 'bar', FunnelChart: 'funnel', HeatmapChart: 'heatmap' }));
vi.mock('echarts/components', () => ({ GridComponent: 'grid', TooltipComponent: 'tooltip', TitleComponent: 'title', LegendComponent: 'legend', VisualMapComponent: 'visualMap' }));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: 'canvas' }));
const spec = (overrides: Partial<ChartSpec> = {}): ChartSpec => ({ kind: 'line', categoryKey: 'date', series: [{ key: 'a', label: 'Visits' }, { key: 'b' }], data: [{ date: '2026-10-25', a: 0, b: 2 }, { date: '2026-10-01', a: 3, b: -1 }], ...overrides });
const theme = { mode: 'light' as const };
const element = (): HTMLDivElement => { const host = document.createElement('div'); document.body.append(host); return host; };
beforeEach(() => {
  vi.resetAllMocks(); vendor.init.mockReturnValue(vendor); document.body.replaceChildren();
  vi.stubGlobal('ResizeObserver', new Proxy(class {
    observe = vendor.observe; disconnect = vendor.disconnect;
  }, {
    construct(target, [callback]) { vendor.resized = callback; return new target(); },
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('registers only the four supported series, used components and canvas renderer', async () => {
  vi.resetModules();
  await import('../src/provider.js');
  expect(vendor.use).toHaveBeenCalledExactlyOnceWith(['line', 'bar', 'funnel', 'heatmap', 'grid', 'tooltip', 'title', 'legend', 'visualMap', 'canvas']);
});

it.each(['line', 'bar'])('maps %s series, zero and date order without coercion', kind => {
  const input = spec({ kind }); const original = JSON.stringify(input);
  const instance = mount({ element: element(), spec: input, theme });
  expect(vendor.setOption).toHaveBeenLastCalledWith(expect.objectContaining({
    animation: false, xAxis: expect.objectContaining({ type: 'category', data: ['2026-10-25', '2026-10-01'] }),
    series: [{ type: kind, name: 'Visits', data: [0, 3] }, { type: kind, name: 'b', data: [2, -1] }],
    tooltip: expect.objectContaining({ renderMode: 'richText' }),
  }), { notMerge: true });
  expect(JSON.stringify(input)).toBe(original); instance.destroy({});
});
it('keeps funnel stage order and zeros', () => {
  const instance = mount({ element: element(), theme, spec: spec({ kind: 'funnel', series: [{ key: 'a' }] }) });
  expect(vendor.setOption.mock.lastCall![0].series).toEqual([expect.objectContaining({ type: 'funnel', sort: 'none', data: [{ name: '2026-10-25', value: 0 }, { name: '2026-10-01', value: 3 }] })]);
  instance.destroy({});
});
it('maps every heatmap cell with stable row and column indices', () => {
  const instance = mount({ element: element(), theme, spec: spec({ kind: 'heatmap' }) });
  expect(vendor.setOption.mock.lastCall![0]).toMatchObject({
    yAxis: { type: 'category', data: ['Visits', 'b'] },
    series: [{ type: 'heatmap', data: [[0, 0, 0], [1, 0, 3], [0, 1, 2], [1, 1, -1]] }],
    visualMap: { min: -1, max: 3 },
  }); instance.destroy({});
});
it.each<Partial<ChartSpec>>([
  { kind: 'pie' }, { series: [] }, { categoryKey: undefined }, { series: Array.from({ length: 17 }, () => ({ key: 'a' })) },
  { data: [{ date: 'x', a: 1, b: null }] }, { data: [{ date: 'x', a: 1, b: '2' }] },
  { data: [{ date: 'x', a: 1, b: Infinity }] }, { data: [{ date: 'x', a: 1 }] },
  { data: [{ date: true, a: 1, b: 2 }] },
  { data: Array.from({ length: 5001 }, () => ({ date: 'x', a: 1 })), series: [{ key: 'a' }] },
  { data: Array.from({ length: 2501 }, () => ({ date: 'x', a: 1, b: 2 })) },
  { kind: 'funnel' }, { kind: 'funnel', series: [{ key: 'b' }] },
])('rejects unsupported or partially invalid data before vendor effects: %j', overrides => {
  expect(() => mount({ element: element(), theme, spec: spec(overrides) })).toThrow(ChartProviderError);
  expect(vendor.init).not.toHaveBeenCalled();
});
it('accepts exactly 5,000 plotted values and 16 series', () => {
  const instance = mount({ element: element(), theme, spec: spec({ data: Array.from({ length: 2500 }, () => ({ date: 'x', a: 0, b: 2 })) }) });
  expect(vendor.setOption.mock.lastCall![0].series[1].data).toHaveLength(2500);
  instance.update({ theme, spec: spec({ series: Array.from({ length: 16 }, () => ({ key: 'a' })) }) });
  expect(vendor.setOption.mock.lastCall![0].series).toHaveLength(16); instance.destroy({});
});
it('updates kind, labels, format and theme; replaces old tokens', () => {
  const host = element(); const instance = mount({ element: host, theme, spec: spec() });
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({ color: 'rgb(1, 2, 3)' } as CSSStyleDeclaration);
  instance.update({ spec: spec({ kind: 'bar', title: 'New', format: { locale: 'de-DE' }, axes: { y: { label: 'Count' } } }), theme: { mode: 'dark', tokens: { '--jini-chart-1': '#123456' } } });
  const options = vendor.setOption.mock.lastCall![0];
  expect(options).toMatchObject({ title: { text: 'New' }, yAxis: { name: 'Count' }, textStyle: { color: 'rgb(1, 2, 3)' }, color: ['rgb(1, 2, 3)', 'rgb(1, 2, 3)'] });
  expect(options.yAxis.axisLabel.formatter(1234.5)).toBe('1.234,5');
  expect(host.firstElementChild!.getAttribute('data-chart-theme')).toBe('dark');
  instance.update({ spec: spec(), theme });
  expect((host.firstElementChild as HTMLElement).style.getPropertyValue('--jini-chart-1')).toBe(''); instance.destroy({});
});
it('resizes, reports asynchronous failures, then releases its observer once', () => {
  const host = element(); const onError = vi.fn(); const instance = mount({ element: host, theme, spec: spec() }, { onError });
  vendor.resized!(); expect(vendor.resize).toHaveBeenCalledOnce();
  vendor.resize.mockImplementationOnce(() => { throw new Error('resize'); }); vendor.resized!();
  expect(onError).toHaveBeenCalledWith(expect.any(ChartProviderError));
  instance.destroy({}); instance.destroy({}); instance.update({ theme, spec: spec() }); vendor.resized!();
  expect(vendor.disconnect).toHaveBeenCalledOnce(); expect(vendor.dispose).toHaveBeenCalledOnce();
  expect(vendor.setOption).toHaveBeenCalledOnce(); expect(host.childElementCount).toBe(0);
});
it('uses window resize when ResizeObserver is unavailable', () => {
  vi.stubGlobal('ResizeObserver', undefined); const instance = mount({ element: element(), theme, spec: spec() });
  window.dispatchEvent(new Event('resize')); instance.destroy({}); window.dispatchEvent(new Event('resize'));
  expect(vendor.resize).toHaveBeenCalledOnce();
});
it('rejects unsupported updates without changing the current chart', () => {
  const instance = mount({ element: element(), theme, spec: spec() });
  expect(() => instance.update({ theme, spec: spec({ kind: 'pie' }) })).toThrow(ChartProviderError);
  expect(vendor.setOption).toHaveBeenCalledOnce(); instance.destroy({});
});
it('removes its frame even when vendor disposal fails', () => {
  const host = element(); const instance = mount({ element: host, theme, spec: spec() });
  vendor.dispose.mockImplementationOnce(() => { throw new Error('dispose'); });
  expect(() => instance.destroy({})).toThrow(ChartProviderError);
  expect(host.childElementCount).toBe(0); instance.destroy({}); expect(vendor.dispose).toHaveBeenCalledOnce();
});
it('releases an instance registered by a partially failed init', () => {
  const host = element(); vendor.init.mockImplementationOnce(() => { throw new Error('init'); });
  vendor.getInstanceByDom.mockReturnValueOnce(vendor);
  expect(() => mount({ element: host, theme, spec: spec() })).toThrow(ChartProviderError);
  expect(vendor.dispose).toHaveBeenCalledOnce(); expect(host.childElementCount).toBe(0);
});
it('disposes a failed first render and keeps the real host table visible', async () => {
  vendor.setOption.mockImplementationOnce(() => { throw new Error('render'); });
  const host = element(); const registry = createChartProviderRegistry({ providers: [{ id: 'plugin.echarts', kinds: ['line'], enabled: true, load: async () => ({ mount }) }] });
  const instance = mountChart({ element: host, spec: spec(), registry }); await instance.ready;
  expect(host.querySelector('table')!.textContent).toContain('2026-10-25');
  expect((host.querySelector('[data-chart-fallback]') as HTMLElement).hidden).toBe(false);
  expect(vendor.dispose).toHaveBeenCalledOnce(); expect(host.querySelector('.jini-chart')).toBeNull(); instance.destroy({});
});
