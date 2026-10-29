import { describe, expect, it } from 'vitest';
import { importSpecifiers, reportingBoundaryViolations } from '../../../development/scripts/boundaries.mjs';

const reporting = 'features/measure/src/reporting/report.ts';
describe('measure reporting dependency boundary', () => {
  it.each([
    'features/measure/src/delivery/dispatcher.ts',
    'features/measure/src/ingestion/ingest.ts',
    'features/policy/index.ts',
    'features/policy/src/rules.ts',
  ])('rejects direct reporting imports of %s', to => {
    expect(reportingBoundaryViolations({ edges: [{ from: reporting, to }] })).toEqual([`${reporting} -> ${to}: measure-reporting-boundary`]);
  });
  it('follows type-only imports and re-exports through a cyclic barrel graph', () => {
    expect(importSpecifiers({ file: reporting, source: 'import type { Evidence } from "../types.js"; export type { Evidence } from "../types.js";' })).toHaveLength(2);
    const shared = 'features/measure/src/types.ts', barrel = 'features/measure/index.ts', forbidden = 'features/measure/src/delivery/input.ts';
    expect(reportingBoundaryViolations({ edges: [
      { from: reporting, to: shared }, { from: shared, to: barrel },
      { from: barrel, to: shared }, { from: barrel, to: forbidden },
    ] })).toEqual([`${reporting} -> ${forbidden}: measure-reporting-boundary`]);
  });
  it('allows safe shared schemas and does not reverse dependency direction', () => {
    const shared = 'features/measure/src/types.ts';
    expect(reportingBoundaryViolations({ edges: [
      { from: reporting, to: shared }, { from: shared, to: 'packages/contracts/src/index.ts' },
      { from: 'features/measure/src/delivery/dispatcher.ts', to: shared },
      { from: 'features/measure/src/service.ts', to: reporting },
    ] })).toEqual([]);
  });
});
