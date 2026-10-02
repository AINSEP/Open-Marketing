import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
/** Explicit dev entry: ephemeral service authority arrives through inherited pipe 3, never argv or renderer code. */
const configurationSchema = z.strictObject({ service: z.enum(['server','agent']), port: z.number().int().min(1024).max(65535), bearer: z.string().min(32).max(256) });
const configuration = configurationSchema.parse(JSON.parse(readFileSync(3, 'utf8')));
/** node:http foreign ABI: request/response are structural objects, never owned positional primitives. */
function respond(request: IncomingMessage, response: ServerResponse): void {
 const supplied = Buffer.from(request.headers.authorization ?? ''); const expected = Buffer.from('Bearer ' + configuration.bearer);
 const authenticated = supplied.length === expected.length && timingSafeEqual(supplied, expected);
 response.setHeader('content-type','application/json');
 if (!authenticated) { response.writeHead(401); response.end(JSON.stringify({ ok: false, error: { code: 'unauthenticated', message: 'Authentication required', retryable: false } })); return; }
 response.writeHead(501); response.end(JSON.stringify({ ok: false, error: { code: 'not_implemented', message: configuration.service + ' shell has no active runtime/capability', retryable: false } }));
}
const server = createServer(respond);
server.listen(configuration.port, '127.0.0.1', () => console.log(JSON.stringify({ service: configuration.service, status: 'shell-listening', port: configuration.port, pid: process.pid, ready: false })));
process.on('SIGTERM', () => server.close());
