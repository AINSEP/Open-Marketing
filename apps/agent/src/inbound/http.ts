/** Minimal loopback JSON control transport; no SSE or vendor routes in the local sandbox. */
import type { createServer, IncomingMessage, ServerResponse, Server } from 'node:http';
import type { Outcome } from '@open-marketing/contracts';
import type { HttpListenerPort, HttpRequest, HttpResponse } from '../ports.js';

function failure(required: { message: string }): Outcome<never> {
    return { ok: false, error: { code: 'invalid_input', message: required.message, retryable: false } };
}

/** Read only after credential/Host checks; JSON bytes are capped before accumulation. */
async function readBody(required: { incoming: IncomingMessage }): Promise<Outcome<unknown>> {
    if (required.incoming.headers['content-type']?.split(';')[0] !== 'application/json') return failure({ message: 'Expected JSON' });
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
        for await (const chunk of required.incoming) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.byteLength;
            if (bytes > 131072) return failure({ message: 'Agent body exceeds 128 KiB' });
            chunks.push(buffer);
        }
        return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown };
    } catch { return failure({ message: 'Malformed agent JSON' }); }
}

function send(required: { outgoing: ServerResponse; response: HttpResponse }): void {
    required.outgoing.writeHead(required.response.status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close' });
    required.outgoing.end(JSON.stringify(required.response.body));
}

/** Native Node callback wrapper. All authentication occurs before body iteration/JSON parsing. */
async function dispatch(required: { incoming: IncomingMessage; outgoing: ServerResponse; origin: string | null; token: string; handle: (required: HttpRequest) => Promise<HttpResponse> }): Promise<void> {
    const { incoming } = required;
    if (incoming.headers.authorization !== 'Bearer ' + required.token) {
        send({ ...required, response: { status: 401, body: { ok: false, error: { code: 'unauthenticated', message: 'Agent control credential required', retryable: false } } } });
        return;
    }
    if (!required.origin || incoming.headers.host !== new URL(required.origin).host || incoming.headers.origin !== undefined) {
        send({ ...required, response: { status: 403, body: failure({ message: 'Agent control requires its loopback origin' }) } }); return;
    }
    try {
        const request = metadata({ incoming });
        if (!request.ok) { send({ ...required, response: { status: 400, body: request } }); return; }
        const body = incoming.method === 'POST' ? await readBody({ incoming }) : { ok: true as const, value: undefined };
        if (!body.ok) { send({ ...required, response: { status: 400, body } }); return; }
        send({ ...required, response: await required.handle({ ...request.value, body: body.value }) });
    } catch { send({ ...required, response: { status: 503, body: { ok: false, error: { code: 'unavailable', message: 'Agent control unavailable', retryable: false } } } }); }
}

function metadata(required: { incoming: IncomingMessage }): Outcome<HttpRequest> {
    const { incoming } = required;
    if (incoming.method !== 'GET' && incoming.method !== 'POST') return failure({ message: 'Unsupported method' });
    if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//') || incoming.url.length > 4096) return failure({ message: 'Invalid control target' });
    const url = new URL(incoming.url, 'http://127.0.0.1');
    const query = Object.fromEntries(url.searchParams);
    if (Object.keys(query).length !== [...url.searchParams].length) return failure({ message: 'Duplicate query fields' });
    return { ok: true, value: { method: incoming.method, path: url.pathname, authorization: incoming.headers.authorization, query } };
}

/** Inert listener; start binds an ephemeral loopback port, stop closes all owned connections.
 * @example const listener = createAgentHttpListener({ createServer, token });
 */
export function createAgentHttpListener(required: { createServer: typeof createServer; token: string }): HttpListenerPort & { origin(required: Record<string, never>): string | null } {
    let server: Server | undefined;
    let origin: string | null = null;
    return {
        origin: () => origin,
        async start({ handle }) {
            if (server) return failure({ message: 'Agent listener already started' });
            server = required.createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 },
                (incoming, outgoing) => { void dispatch({ incoming, outgoing, origin, token: required.token, handle }); });
            server.maxConnections = 16;
            server.maxHeadersCount = 32;
            const owned = server;
            return new Promise<Outcome<void>>(resolve => {
                function failed() { owned.off('listening', ready); owned.close(); server = undefined; resolve(failure({ message: 'Agent listener bind failed' })); }
                function ready() {
                    owned.off('error', failed);
                    const address = owned.address();
                    if (!address || typeof address === 'string') { failed(); return; }
                    origin = 'http://127.0.0.1:' + address.port;
                    resolve({ ok: true, value: undefined });
                }
                owned.once('error', failed); owned.once('listening', ready); owned.listen(0, '127.0.0.1');
            });
        },
        async stop() {
            const owned = server;
            server = undefined; origin = null;
            if (!owned) return { ok: true, value: undefined };
            return new Promise<Outcome<void>>(resolve => { owned.close(error => resolve(error ? failure({ message: 'Agent listener cleanup failed' }) : { ok: true, value: undefined })); owned.closeAllConnections(); });
        },
    };
}
