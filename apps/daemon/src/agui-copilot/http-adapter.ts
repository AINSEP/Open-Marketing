import type { IncomingMessage, ServerResponse } from 'node:http';

import { createCopilotNodeRuntimeHandler } from './runtime.js';

// The Node ↔ CopilotKit seam. CopilotKit's handler needs the untouched raw
// request, so the daemon mounts this at the http.Server level (before Express)
// rather than as Express middleware — routing through Express reshapes the
// request enough that the single-route handler 415s it.
export interface AguiHttpHandler {
  /** True for requests this handler owns (the CopilotKit base path). */
  matches(url: string | undefined): boolean;
  /** Serve a matched request with the raw Node req/res. */
  handle(req: IncomingMessage, res: ServerResponse): void;
}

const BASE_PATH = '/api/copilotkit';

export function createAguiHttpHandler(): AguiHttpHandler {
  const handler = createCopilotNodeRuntimeHandler();
  return {
    matches(url) {
      const path = (url ?? '').split('?')[0] ?? '';
      return path === BASE_PATH || path.startsWith(`${BASE_PATH}/`);
    },
    handle(req, res) {
      // Open Design's web analytics fetch wrapper re-sends the CopilotKit
      // agent-run POST without CopilotKit's 'application/json' header, so the
      // browser defaults the body to 'text/plain;charset=UTF-8'. CopilotKit's
      // single-route handler 415s any non-JSON content-type even though the
      // body IS json ({"method":"agent/run",...}). Normalize it. (Verified by
      // diffing the runtime-info POST, which keeps application/json, against
      // the agent-run POST, which arrives as text/plain with x-od-analytics-*.)
      const contentType = req.headers['content-type'] ?? '';
      if (req.method === 'POST' && contentType.startsWith('text/plain')) {
        req.headers['content-type'] = 'application/json';
      }
      void handler(req, res);
    },
  };
}
