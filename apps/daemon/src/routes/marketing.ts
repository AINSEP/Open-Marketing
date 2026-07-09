import type Database from 'better-sqlite3';
import type { Express } from 'express';
import type { MarketingOverviewResponse } from '@open-design/contracts';
import type { RouteDeps } from '../server-context.js';
import { defineJsonRoute, mountJsonRoute, ok, type Result } from '../http/index.js';
import { getMarketingOverview } from '../marketing/store.js';

type SqliteDatabase = Database.Database;

export interface RegisterMarketingRoutesDeps extends RouteDeps<'db' | 'http'> {}

interface MarketingDomainDeps {
  db: SqliteDatabase;
  getOverview: (db: SqliteDatabase) => MarketingOverviewResponse;
}

function handleGetMarketingOverview(
  _input: void,
  deps: MarketingDomainDeps,
): Result<MarketingOverviewResponse> {
  return ok(deps.getOverview(deps.db));
}

export const getMarketingOverviewRoute = defineJsonRoute<void, MarketingOverviewResponse, MarketingDomainDeps>({
  method: 'get',
  path: '/api/marketing/overview',
  requireSameOrigin: true,
  parse: () => ok(undefined),
  handle: handleGetMarketingOverview,
});

export function registerMarketingRoutes(app: Express, ctx: RegisterMarketingRoutesDeps): void {
  const domainDeps: MarketingDomainDeps = {
    db: ctx.db,
    getOverview: getMarketingOverview,
  };
  mountJsonRoute(app, getMarketingOverviewRoute, domainDeps, {
    resolvedPortRef: ctx.http.resolvedPortRef,
  });
}
