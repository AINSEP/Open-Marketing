/** Standalone ECharts adapter for Jini's neutral chart ABI; no OM runtime imports. */
import { getInstanceByDom, init, use } from 'echarts/core';
import type { ECharts, EChartsOption, TooltipComponentOption } from 'echarts';
import { LineChart, BarChart, FunnelChart, HeatmapChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, TitleComponent, LegendComponent, VisualMapComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { chartSpecSchema, type ChartInstance, type ChartMountOptions, type ChartRenderInput, type ChartSpec } from '@jini-ai/ui/charts';
import { applyChartTheme } from '@jini-ai/ui/charts/browser';

use([LineChart, BarChart, FunnelChart, HeatmapChart, GridComponent, TooltipComponent, TitleComponent, LegendComponent, VisualMapComponent, CanvasRenderer]);

/** Boundary failure: the host retains its existing data table when a provider fails. */
export class ChartProviderError extends Error {
  constructor(readonly details: { code: 'invalid_spec' | 'render_failed'; cause?: unknown }) {
    super(`ECharts provider: ${details.code}`, { cause: details.cause });
    this.name = 'ChartProviderError';
  }
}

const kinds = ['line', 'bar', 'funnel', 'heatmap'];
const defaults = ['#007A52', '#B7791F', '#D14343', '#64748B', '#8B5CF6', '#0891B2'];

/** Validate the published schema and plotted cells before invoking vendor code.
 * O(input size + plotted values) time/space; plots are capped at 5,000 values/16 series.
 */
function validate({ spec }: { spec: ChartSpec }): ChartSpec {
  if (spec?.data?.length > 5000 || spec?.series?.length > 16) throw new ChartProviderError({ code: 'invalid_spec' });
  const parsed = chartSpecSchema.safeParse(spec);
  if (!parsed.success) throw new ChartProviderError({ code: 'invalid_spec', cause: parsed.error });
  const next = parsed.data;
  if (!kinds.includes(next.kind) || !next.categoryKey || next.series.length === 0) throw new ChartProviderError({ code: 'invalid_spec' });
  if (next.data.length * next.series.length > 5000) throw new ChartProviderError({ code: 'invalid_spec' });
  if (next.kind === 'funnel' && next.series.length !== 1) throw new ChartProviderError({ code: 'invalid_spec' });
  for (const row of next.data) validateRow({ row, spec: next });
  return next;
}

function validateRow({ row, spec }: { row: ChartSpec['data'][number]; spec: ChartSpec }): void {
  const category = row[spec.categoryKey!];
  if (typeof category !== 'string' && !(typeof category === 'number' && Number.isFinite(category))) throw new ChartProviderError({ code: 'invalid_spec' });
  for (const series of spec.series) {
    const value = row[series.key];
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new ChartProviderError({ code: 'invalid_spec' });
    if (spec.kind === 'funnel' && value < 0) throw new ChartProviderError({ code: 'invalid_spec' });
  }
}

/** Resolve CSS variables through the supplied document: canvas cannot paint CSS var() strings. */
function color({ element, value }: { element: HTMLElement; value: string }): string {
  const swatch = element.ownerDocument.createElement('span');
  swatch.style.color = value;
  element.append(swatch);
  const resolved = element.ownerDocument.defaultView!.getComputedStyle(swatch).color;
  swatch.remove();
  return resolved;
}

/** Refresh host tokens on every update before resolving canvas colors. */
function appearance({ element, input }: { element: HTMLElement; input: ChartRenderInput }) {
  applyChartTheme({ element, theme: input.theme });
  const dark = input.theme.mode === 'dark';
  const palette = defaults.map((fallback, index) => color({ element, value: `var(--jini-chart-${index + 1}, var(--jini-chart-default-${index + 1}, ${fallback}))` }));
  return {
    palette,
    text: color({ element, value: `var(--jini-chart-text, ${dark ? '#E2E8F0' : '#172033'})` }),
    axis: color({ element, value: `var(--jini-chart-axis, ${dark ? '#94A3B8' : '#64748B'})` }),
    grid: color({ element, value: `var(--jini-chart-grid, ${dark ? '#334155' : '#E2E8F0'})` }),
    surface: color({ element, value: `var(--jini-chart-surface, ${dark ? '#172033' : '#FFFFFF'})` }),
  };
}

/** ECharts formatter ABI is positional; only finite plotted numbers reach numeric formatting. */
function formatter({ format }: { format: ChartSpec['format'] }) {
  const number = new Intl.NumberFormat(format?.locale ?? 'en-US', { notation: format?.notation ?? 'standard', maximumFractionDigits: 20 });
  return ((value: unknown): string => {
    const scalar = Array.isArray(value) ? value.at(-1) : value;
    return typeof scalar === 'number' ? number.format(scalar) : String(scalar);
  }) satisfies NonNullable<TooltipComponentOption['valueFormatter']>;
}

/** Translate one bounded spec. Heatmap columns follow rows; its rows follow series order. */
function option({ spec, element, input }: { spec: ChartSpec; element: HTMLElement; input: ChartRenderInput }): EChartsOption {
  const theme = appearance({ element, input });
  const xFormat = formatter({ format: spec.axes?.x?.format });
  const yFormat = formatter({ format: spec.axes?.y?.format ?? spec.format });
  const categories = spec.data.map(row => xFormat(row[spec.categoryKey!]));
  const seriesColors = spec.series.map((series, index) => color({ element, value: series.color ?? theme.palette[index % theme.palette.length]! }));
  const base: EChartsOption = {
    animation: false, color: seriesColors, textStyle: { color: theme.text },
    title: { text: spec.title, subtext: spec.description, textStyle: { color: theme.text }, subtextStyle: { color: theme.axis } },
    tooltip: { renderMode: 'richText', backgroundColor: theme.surface, textStyle: { color: theme.text }, valueFormatter: formatter({ format: spec.format }) },
  };
  if (spec.kind === 'funnel') return { ...base, series: [{
    type: 'funnel', sort: 'none', top: 65, bottom: 25, name: spec.series[0]!.label ?? spec.series[0]!.key,
    data: spec.data.map((row, index) => ({ name: categories[index]!, value: row[spec.series[0]!.key] as number })),
    label: { color: theme.text },
  }] };
  const axes = {
    grid: { top: 80, bottom: 65, left: 65, right: 30, containLabel: true },
    xAxis: { type: 'category' as const, data: categories, name: spec.axes?.x?.label, axisLabel: { color: theme.axis } },
    yAxis: { type: 'value' as const, name: spec.axes?.y?.label, axisLabel: { color: theme.axis, formatter: yFormat }, splitLine: { lineStyle: { color: theme.grid } } },
  };
  if (spec.kind === 'heatmap') return heatmap({ spec, base: { ...base, ...axes }, theme });
  return { ...base, ...axes,
    legend: { bottom: 0, textStyle: { color: theme.text } },
    series: spec.series.map(series => ({ type: spec.kind as 'line' | 'bar', name: series.label ?? series.key, data: spec.data.map(row => row[series.key] as number) })),
  };
}

/** Bound extrema and retain a nonzero visual range for empty/all-zero heatmaps. */
function heatmap({ spec, base, theme }: { spec: ChartSpec; base: EChartsOption; theme: ReturnType<typeof appearance> }): EChartsOption {
  const data = spec.series.flatMap((series, y) => spec.data.map((row, x) => [x, y, row[series.key] as number]));
  const values = data.map(cell => cell[2]!);
  return { ...base,
    yAxis: { type: 'category', data: spec.series.map(series => series.label ?? series.key), name: spec.axes?.y?.label, axisLabel: { color: theme.axis } },
    visualMap: { min: Math.min(0, ...values), max: Math.max(1, ...values), bottom: 0, orient: 'horizontal', calculable: false, textStyle: { color: theme.text }, inRange: { color: [theme.surface, theme.palette[0]!] } },
    series: [{ type: 'heatmap', data }],
  };
}

/** Mount owns a single renderer and resize subscription; synchronous errors retain host fallback.
 * @param input Host-owned element, neutral spec and theme. No global document is used.
 * @param options Receives asynchronous resize failures.
 * @returns Idempotently disposable Jini chart instance.
 * @throws {ChartProviderError} Invalid specs or vendor rendering failures.
 * @example mount({ element, spec, theme }, { onError: reportProviderFailure })
 */
export function mount({ element, ...input }: ChartRenderInput & { element: HTMLElement }, options: ChartMountOptions = {}): ChartInstance {
  const spec = validate({ spec: input.spec });
  const frame = element.ownerDocument.createElement('div');
  frame.className = 'jini-chart'; frame.dataset.chartProvider = 'plugin.echarts';
  element.append(frame);
  let chart: ECharts | undefined;
  let observer: ResizeObserver | undefined;
  let destroyed = false;
  const view = element.ownerDocument.defaultView!;
  /** Disconnect callbacks before disposing the renderer; always remove the owned frame. */
  function destroy(_input = {}, _options = {}): void {
    if (destroyed) return;
    destroyed = true;
    observer?.disconnect(); view.removeEventListener('resize', resize);
    try { chart?.dispose(); }
    catch (cause) { throw new ChartProviderError({ code: 'render_failed', cause }); }
    finally { frame.remove(); }
  }
  /** Validate before vendor effects; replace options so kind changes leave no stale series. */
  function update(next: ChartRenderInput, _options = {}): void {
    if (destroyed) return;
    const nextSpec = validate({ spec: next.spec });
    try {
      const nextOption = option({ spec: nextSpec, element: frame, input: next });
      frame.setAttribute('role', 'img'); frame.setAttribute('aria-label', nextSpec.description ?? nextSpec.title ?? 'Chart');
      chart!.setOption(nextOption, { notMerge: true });
    } catch (cause) { throw new ChartProviderError({ code: 'render_failed', cause }); }
  }
  /** ResizeObserver/window callback ABIs supply no chart input. */
  function resize(): void {
    if (destroyed) return;
    try { chart!.resize(); } catch (cause) { options.onError?.(new ChartProviderError({ code: 'render_failed', cause })); }
  }
  try {
    chart = init(frame, undefined, { renderer: 'canvas' });
    update({ ...input, spec });
    const Observer = (view as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    if (Observer) { observer = new Observer(resize); observer.observe(frame); }
    else view.addEventListener('resize', resize);
  } catch (cause) {
    chart ??= getInstanceByDom(frame);
    destroy();
    throw new ChartProviderError({ code: 'render_failed', cause });
  }
  return { update, destroy };
}
