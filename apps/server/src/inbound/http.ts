/** Node transport only: bounded metadata/body reads, static studio assets, explicit lifecycle. */
import type { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { IdPort, ObserverPort, Outcome } from '@open-marketing/contracts';
import type { HttpListenerPort, HttpRequest, HttpResponse } from '../ports.js';
import { localFailure, readLocalFile, type LocalFilesystem } from '../composition/local-auth.js';

/** Node effects are created only at composition; schedule is a cancellable shutdown deadline. */
export interface HttpEffects {
    createServer: typeof createServer;
    schedule(required: { callback: () => void; delayMs: number }): () => void;
}
/** Explicit listener port adds its actual address for ephemeral-port boot/readiness. */
export interface NodeHttpListener extends HttpListenerPort { origin(required: Record<string, never>): string | null }

/** Parse method/path/unique query/headers without consuming the body. Native callbacks implement
 * Node's positional ABI; tests exercise them through loopback HTTP. @complexity O(h+u), <=16 KiB headers/4096 URL chars.
 */
function requestMetadata(required: { incoming: IncomingMessage }): Outcome<HttpRequest> {
    const incoming = required.incoming;
    if (incoming.method !== 'GET' && incoming.method !== 'POST') return localFailure({ code: 'invalid_input', message: 'Only GET and POST are supported' });
    if (!incoming.url || incoming.url.length > 4096 || !incoming.url.startsWith('/') || incoming.url.startsWith('//')) {
        return localFailure({ code: 'invalid_input', message: 'Invalid request target' });
    }
    try {
        const url = new URL(incoming.url, 'http://127.0.0.1');
        const query = Object.fromEntries(url.searchParams);
        if (Object.keys(query).length !== [...url.searchParams].length) return localFailure({ code: 'invalid_input', message: 'Duplicate query parameters are not supported' });
        const headers: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) return localFailure({ code: 'invalid_input', message: 'Duplicate request headers are not supported' });
            headers[name] = value;
        }
        let body: Promise<Outcome<unknown>> | undefined;
        return { ok: true, value: { method: incoming.method, path: url.pathname, query, headers,
            authorization: headers.authorization, readBody: () => body ??= readJsonBody({ incoming }) } };
    } catch { return localFailure({ code: 'invalid_input', message: 'Invalid request URL' }); }
}

/** Lazy JSON edge; handlers call only after authentication. Never buffers beyond 128 KiB.
 * @returns Unknown JSON for the route schema, or an input/size failure; no automatic retries.
 * @complexity O(b) time/space, b <=128 KiB. Node requestTimeout bounds body delivery.
 */
async function readJsonBody(required: { incoming: IncomingMessage }): Promise<Outcome<unknown>> {
    if (required.incoming.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
        return localFailure({ code: 'invalid_input', message: 'Expected application/json' });
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
        for await (const chunk of required.incoming) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.byteLength;
            if (bytes > 131072) return localFailure({ code: 'limit_exceeded', message: 'Request body exceeds 128 KiB' });
            chunks.push(buffer);
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        return { ok: true, value: JSON.parse(text) as unknown };
    } catch { return localFailure({ code: 'invalid_input', message: 'Malformed or interrupted JSON body' }); }
}

/** Serialize trusted route outcomes. Error replies close unconsumed request bodies; no CORS grants. */
function sendResponse(required: { outgoing: ServerResponse; response: HttpResponse }): void {
    const { outgoing, response } = required;
    outgoing.writeHead(response.status, { 'content-type': response.contentType ?? 'application/json; charset=utf-8',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        ...(response.status >= 400 ? { connection: 'close' } : {}), ...response.headers });
    if (response.contentType) { outgoing.end(response.body); return; }
    outgoing.end(JSON.stringify(response.body));
}

/** Exact Host check defends loopback from DNS rebinding; any supplied Origin must match.
 * Health/static reads use the same host boundary as owner requests. @complexity O(1).
 */
function trustedOrigin(required: { request: HttpRequest; origin: string }): boolean {
    return required.request.headers?.host === new URL(required.origin).host
        && (required.request.headers?.origin === undefined || required.request.headers.origin === required.origin);
}

/** Best-effort transport telemetry uses bounded generated IDs, never raw URLs, cookies or bodies. */
function observeRequest(required: { observer: ObserverPort; ids: IdPort; incoming: IncomingMessage; outcome: string }): void {
    try { required.observer.observe({ operation: 'server.http.request', outcome: required.outcome,
        correlationId: traceIdentifier({ value: required.incoming.headers['x-correlation-id'], ids: required.ids }),
        traceId: traceIdentifier({ value: required.incoming.headers['x-trace-id'], ids: required.ids }) }); }
    catch { /* Diagnostics cannot turn a sent response into a failed operation. */ }
}

/** Validated client tracing is propagated; absent/tainted values receive server-generated IDs. */
function traceIdentifier(required: { value: string | string[] | undefined; ids: IdPort }): string {
    const parsed = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/).safeParse(required.value);
    return parsed.success ? parsed.data : required.ids.next({});
}

/** Dispatch through an authenticated app handler and map opaque transport faults to typed replies. */
async function dispatchRequest(required: {
    incoming: IncomingMessage; outgoing: ServerResponse; listener: NodeHttpListener;
    handle: (required: HttpRequest) => Promise<HttpResponse>; observer: ObserverPort; ids: IdPort;
}): Promise<void> {
    let outcome = 'unavailable';
    try {
        const request = requestMetadata({ incoming: required.incoming });
        if (!request.ok) { outcome = '400'; sendResponse({ outgoing: required.outgoing, response: { status: 400, body: request } }); return; }
        const origin = required.listener.origin({});
        if (!origin || !trustedOrigin({ request: request.value, origin })) {
            outcome = '403';
            sendResponse({ outgoing: required.outgoing, response: { status: 403, body: localFailure({ code: 'forbidden', message: 'Request must use the local server origin' }) } });
            return;
        }
        const response = await required.handle(request.value);
        outcome = String(response.status);
        sendResponse({ outgoing: required.outgoing, response });
    } catch {
        outcome = 'unavailable';
        if (!required.outgoing.headersSent) sendResponse({ outgoing: required.outgoing, response: { status: 503, body: localFailure({ message: 'HTTP request unavailable' }) } });
        else required.outgoing.destroy();
    } finally { observeRequest({ ...required, outcome }); }
}

/** Bind with cleanup on error. This function wraps Node's error/listening callback ABI. */
function listen(required: { server: Server; host: string; port: number }): Promise<Outcome<void>> {
    return new Promise(resolveResult => {
        function failed() { required.server.off('listening', ready); resolveResult(localFailure({ message: 'Could not bind the local HTTP listener' })); }
        function ready() { required.server.off('error', failed); resolveResult({ ok: true, value: undefined }); }
        required.server.once('error', failed);
        required.server.once('listening', ready);
        required.server.listen(required.port, required.host);
    });
}

/** Stop admission, drain connections for at most five seconds, then force-close sockets. */
function closeListener(required: { server: Server; effects: HttpEffects }): Promise<Outcome<void>> {
    return new Promise(resolveResult => {
        const cancel = required.effects.schedule({ delayMs: 5000, callback: () => required.server.closeAllConnections() });
        required.server.close(error => {
            cancel();
            if (error) resolveResult(localFailure({ message: 'HTTP listener cleanup failed' }));
            else resolveResult({ ok: true, value: undefined });
        });
        required.server.closeIdleConnections();
    });
}

/** Inert factory; starts only when requested, binds loopback, and closes all owned connections.
 * @example const listener = createNodeHttpListener({ host, port, effects, ids, observer });
 * @complexity O(1) factory space; native connections capped at 64, headers 16 KiB, request timeout 15s.
 */
export function createNodeHttpListener(required: {
    host: '127.0.0.1'; port: number; effects: HttpEffects; ids: IdPort; observer: ObserverPort;
}): NodeHttpListener {
    let server: Server | undefined;
    let origin: string | null = null;
    const listener: NodeHttpListener = {
        origin: () => origin,
        async start({ handle }) {
            if (server) return localFailure({ code: 'conflict', message: 'HTTP listener has already started' });
            server = required.effects.createServer({ maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 5000 },
                (incoming, outgoing) => { void dispatchRequest({ incoming, outgoing, listener, handle, observer: required.observer, ids: required.ids }); });
            server.maxConnections = 64;
            server.maxHeadersCount = 100;
            const started = await listen({ server, host: required.host, port: required.port });
            if (!started.ok) { server.close(); server = undefined; return started; }
            const address = server.address();
            if (!address || typeof address === 'string') return localFailure({ message: 'HTTP address unavailable' });
            origin = `http://${required.host}:${address.port}`;
            return { ok: true, value: undefined };
        },
        async stop() {
            if (!server) return { ok: true, value: undefined };
            const owned = server;
            server = undefined;
            origin = null;
            return closeListener({ server: owned, effects: required.effects });
        },
    };
    return listener;
}

const contentTypes: Readonly<Record<string, string>> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

/** Validate built index before readiness; missing output fails boot with a build instruction. */
export async function prepareStudioAssets(required: { fs: LocalFilesystem; studioRoot: string }): Promise<Outcome<string>> {
    try {
        const root = await required.fs.realpath(required.studioRoot);
        await readLocalFile({ fs: required.fs, path: join(root, 'index.html'), maxBytes: 1048576 });
        return { ok: true, value: root };
    } catch { return localFailure({ message: 'Built studio assets are unavailable; build @open-marketing/studio first' }); }
}

/** Reject encoded traversal and sensitive extensions; resolve symlinks before containment checks.
 * SPA routes serve index.html; /assets paths must name real built files. No directory listing.
 * @returns HTML/bytes or a typed 404/400. @complexity O(b), b <=8 MiB per asset.
 */
export async function serveStudioAsset(required: { request: HttpRequest; fs: LocalFilesystem; studioRoot: string }): Promise<HttpResponse> {
    if (required.request.method !== 'GET') return { status: 405, body: localFailure({ code: 'invalid_input', message: 'Static assets require GET' }) };
    try {
        const path = decodeURIComponent(required.request.path);
        if (path.includes('\0') || path.includes('\\') || path.split('/').some(segment => segment === '..' || segment === '.')) {
            return { status: 400, body: localFailure({ code: 'invalid_input', message: 'Invalid static path' }) };
        }
        const extension = extname(path);
        const relativePath = path.startsWith('/assets/') || extension ? path.slice(1) : 'index.html';
        const type = contentTypes[extname(relativePath)];
        if (!type) return { status: 404, body: localFailure({ code: 'invalid_input', message: 'Asset not found' }) };
        const file = await required.fs.realpath(resolve(required.studioRoot, relativePath));
        const containment = relative(required.studioRoot, file);
        if (isAbsolute(containment) || containment.startsWith('..')) return { status: 404, body: localFailure({ code: 'forbidden', message: 'Asset is outside studio' }) };
        const bytes = await readLocalFile({ fs: required.fs, path: file, maxBytes: 8388608 });
        return { status: 200, contentType: type, body: bytes };
    } catch { return { status: 404, body: localFailure({ code: 'invalid_input', message: 'Asset not found' }) }; }
}
