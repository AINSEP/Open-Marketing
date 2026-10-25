/** Chart feature public API. Composition supplies one abortable provider snapshot to chat/A2UI. */
export { loadStudioChartProviders } from './charts.js';
export type { StudioChartDependencies } from './charts.js';
export type { ChartProviderRegistry } from '@jini-ai/ui/charts';
export { mountChart } from '@jini-ai/ui/charts/browser';
export { createBrowserChartHost } from './browser.js';
export type { StudioChartHost } from './browser.js';
export { useStudioChartProviders } from './use-chart-providers.js';
