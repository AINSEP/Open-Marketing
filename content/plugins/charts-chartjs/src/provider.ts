/** Standalone Chart.js adapter: category-spaced lines and bars, with no date adapter. */
import { Chart, LineController, BarController, LineElement, PointElement, BarElement, CategoryScale, LinearScale, Title, SubTitle, Legend, Tooltip } from 'chart.js';
import type { ChartConfiguration, ChartType, TickOptions } from 'chart.js';
import { chartSpecSchema, type ChartInstance, type ChartMountOptions, type ChartRenderInput, type ChartSpec } from '@jini-ai/ui/charts';
import { applyChartTheme } from '@jini-ai/ui/charts/browser';

Chart.register(LineController, BarController, LineElement, PointElement, BarElement, CategoryScale, LinearScale, Title, SubTitle, Legend, Tooltip);

/** Boundary failure: Jini's host keeps the data table available. */
export class ChartProviderError extends Error {
  constructor(readonly details: { code: 'invalid_spec' | 'render_failed'; cause?: unknown }) {
    super(`Chart.js provider: ${details.code}`, { cause: details.cause });
    this.name = 'ChartProviderError';
  }
}

const defaults = ['#007A52', '#B7791F', '#D14343', '#64748B', '#8B5CF6', '#0891B2'];
type Kind = Extract<ChartType, 'line' | 'bar'>;

/** Published schema plus numeric admission. O(input size + plotted values); plots capped at 5,000/16. */
function validate({ spec }: { spec: ChartSpec }): ChartSpec & { kind: Kind } {
  if (spec?.data?.length > 5000 || spec?.series?.length > 16) throw new ChartProviderError({ code: 'invalid_spec' });
  const parsed = chartSpecSchema.safeParse(spec);
  if (!parsed.success) throw new ChartProviderError({ code: 'invalid_spec', cause: parsed.error });
  const next = parsed.data;
  if (next.kind !== 'line' && next.kind !== 'bar') throw new ChartProviderError({ code: 'invalid_spec' });
  if (!next.categoryKey || next.series.length === 0 || next.data.length * next.series.length > 5000) throw new ChartProviderError({ code: 'invalid_spec' });
  for (const row of next.data) validateRow({ row, spec: next });
  return { ...next, kind: next.kind };
}

function validateRow({ row, spec }: { row: ChartSpec['data'][number]; spec: ChartSpec }): void {
  const category = row[spec.categoryKey!];
  if (typeof category !== 'string' && !(typeof category === 'number' && Number.isFinite(category))) throw new ChartProviderError({ code: 'invalid_spec' });
  for (const series of spec.series) {
    const value = row[series.key];
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new ChartProviderError({ code: 'invalid_spec' });
  }
}

/** Resolve host/theme CSS variables to actual canvas paint colors in the supplied document. */
function color({ element, value }: { element: HTMLElement; value: string }): string {
  const swatch = element.ownerDocument.createElement('span');
  swatch.style.color = value; element.append(swatch);
  const resolved = element.ownerDocument.defaultView!.getComputedStyle(swatch).color;
  swatch.remove();
  return resolved;
}

/** Refresh tokens before resolving colors; keep this plugin independent of other providers. */
function appearance({ element, input }: { element: HTMLElement; input: ChartRenderInput }) {
  applyChartTheme({ element, theme: input.theme });
  const dark = input.theme.mode === 'dark';
  return {
    palette: defaults.map((fallback, index) => color({ element, value: `var(--jini-chart-${index + 1}, var(--jini-chart-default-${index + 1}, ${fallback}))` })),
    text: color({ element, value: `var(--jini-chart-text, ${dark ? '#E2E8F0' : '#172033'})` }),
    axis: color({ element, value: `var(--jini-chart-axis, ${dark ? '#94A3B8' : '#64748B'})` }),
    grid: color({ element, value: `var(--jini-chart-grid, ${dark ? '#334155' : '#E2E8F0'})` }),
    surface: color({ element, value: `var(--jini-chart-surface, ${dark ? '#172033' : '#FFFFFF'})` }),
  };
}

/** Chart.js tick/tooltip callbacks are positional, so wrap Intl at this adapter boundary. */
function formatter({ format }: { format: ChartSpec['format'] }) {
  const number = new Intl.NumberFormat(format?.locale ?? 'en-US', { notation: format?.notation ?? 'standard', maximumFractionDigits: 20 });
  return ((value: unknown): string => typeof value === 'number' ? number.format(value) : String(value)) satisfies TickOptions['callback'];
}

/** Translate only admitted numeric series; no mutation of host data. O(plotted values) space/time. */
function configuration({ spec, element, input }: { spec: ChartSpec & { kind: Kind }; element: HTMLElement; input: ChartRenderInput }): ChartConfiguration<Kind, number[], string> {
  const theme = appearance({ element, input });
  const xFormat = formatter({ format: spec.axes?.x?.format });
  const yFormat = formatter({ format: spec.axes?.y?.format ?? spec.format });
  const valueFormat = formatter({ format: spec.format });
  return {
    type: spec.kind,
    data: {
      labels: spec.data.map(row => xFormat(row[spec.categoryKey!])),
      datasets: spec.series.map((series, index) => {
        const ink = color({ element, value: series.color ?? theme.palette[index % theme.palette.length]! });
        return { label: series.label ?? series.key, data: spec.data.map(row => row[series.key] as number), backgroundColor: ink, borderColor: ink };
      }),
    },
    options: {
      animation: false, responsive: true, maintainAspectRatio: false, color: theme.text,
      plugins: {
        title: { display: Boolean(spec.title), text: spec.title ?? '', color: theme.text },
        subtitle: { display: Boolean(spec.description), text: spec.description ?? '', color: theme.axis },
        legend: { labels: { color: theme.text } },
        tooltip: { backgroundColor: theme.surface, titleColor: theme.text, bodyColor: theme.text,
          callbacks: { label: context => `${context.dataset.label ?? ''}: ${valueFormat(context.parsed.y)}` } },
      },
      scales: {
        x: { type: 'category', title: { display: Boolean(spec.axes?.x?.label), text: spec.axes?.x?.label ?? '', color: theme.axis }, ticks: { color: theme.axis }, grid: { color: theme.grid } },
        y: { type: 'linear', beginAtZero: true, title: { display: Boolean(spec.axes?.y?.label), text: spec.axes?.y?.label ?? '', color: theme.axis }, ticks: { color: theme.axis, callback: yFormat }, grid: { color: theme.grid } },
      },
    },
  };
}

/** Mount one canvas; Chart.js owns its responsive observer and releases it on destroy.
 * @param input Supplied element, neutral numeric spec and chart theme.
 * @param _options Reserved Jini lifecycle options; rendering here is synchronous.
 * @returns Instance whose update can change kind, data and theme; destruction is idempotent.
 * @throws {ChartProviderError} Invalid specs or vendor failures; the host owns table fallback.
 * @example mount({ element, spec, theme })
 */
export function mount({ element, ...input }: ChartRenderInput & { element: HTMLElement }, _options: ChartMountOptions = {}): ChartInstance {
  const spec = validate({ spec: input.spec });
  const frame = element.ownerDocument.createElement('div');
  frame.className = 'jini-chart'; frame.dataset.chartProvider = 'plugin.chartjs';
  const canvas = element.ownerDocument.createElement('canvas');
  frame.append(canvas); element.append(frame);
  let chart: Chart<Kind, number[], string> | undefined;
  let destroyed = false;
  /** Chart.js releases its listeners/observers; always remove only the owned frame. */
  function destroy(_input = {}, _options = {}): void {
    if (destroyed) return;
    destroyed = true;
    try { chart?.destroy(); }
    catch (cause) { throw new ChartProviderError({ code: 'render_failed', cause }); }
    finally { frame.remove(); }
  }
  /** Validate before mutating the vendor instance; replace datasets, options and kind together. */
  function update(next: ChartRenderInput, _options = {}): void {
    if (destroyed) return;
    const nextSpec = validate({ spec: next.spec });
    try {
      const config = configuration({ spec: nextSpec, element: frame, input: next });
      canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', nextSpec.description ?? nextSpec.title ?? 'Chart');
      if (!chart) {
        chart = new Chart(canvas, config);
        if (!chart.ctx) throw new ChartProviderError({ code: 'render_failed' });
        return;
      }
      Object.assign(chart.config, { type: config.type }); chart.data = config.data; chart.options = config.options!;
      chart.update('none');
    } catch (cause) { throw new ChartProviderError({ code: 'render_failed', cause }); }
  }
  try { update({ ...input, spec }); }
  catch (cause) {
    chart ??= Chart.getChart(canvas) as Chart<Kind, number[], string> | undefined;
    destroy();
    throw new ChartProviderError({ code: 'render_failed', cause });
  }
  return { update, destroy };
}
