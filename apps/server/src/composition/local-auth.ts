/** Local-only owner bootstrap. Persistent credentials are one private file, not a session store. */
import { constants } from 'node:fs';
import type * as filesystem from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AppError, ClockPort, IdPort, Outcome, Scope } from '@open-marketing/contracts';
import type { HttpRequest, HttpResponse } from '../ports.js';

/** Native filesystem ABI, supplied by executable composition or a temporary-file test. */
export type LocalFilesystem = Pick<typeof filesystem, 'open' | 'mkdir' | 'chmod' | 'realpath'>;
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/);
const credentialsSchema = z.strictObject({ token: tokenSchema, ownerId: z.uuid(), workspaceId: z.uuid() });
/** Owner scope and token stay server-side; neither is derived from request payloads. */
export type LocalCredentials = z.infer<typeof credentialsSchema>;
const originSchema = z.url().max(2048).refine(value => {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) > 0
        && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
});
const endpointSchema = z.strictObject({ serverUrl: originSchema });

/** Stable app-boundary failure; diagnostics never echo files, credentials or request bodies. */
export function localFailure<T>(required: { code?: AppError['code']; message: string }): Outcome<T> {
    return { ok: false, error: { code: required.code ?? 'unavailable', message: required.message, retryable: false } };
}

/** Read at most maxBytes+1 bytes, rejecting symlinks and non-files before buffering.
 * Private files must have exactly 0600 permissions. Native failures are mapped by the caller.
 * @complexity O(b) time/space for b <= maxBytes+1; one open/read/close.
 */
export async function readLocalFile(required: { fs: LocalFilesystem; path: string; maxBytes: number; private?: true }): Promise<Buffer> {
    const file = await required.fs.open(required.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > required.maxBytes) throw new RangeError('Invalid local file size or type');
        if (required.private && (stat.mode & 0o777) !== 0o600) throw new RangeError('Local credential file must be 0600');
        const buffer = Buffer.alloc(stat.size + 1);
        let total = 0;
        while (total < buffer.length) {
            const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
            if (bytesRead === 0) break;
            total += bytesRead;
        }
        if (total > stat.size) throw new RangeError('Local file changed while reading');
        return buffer.subarray(0, total);
    } finally { await file.close(); }
}

/** Write private server-owned metadata, refusing symlink destinations. Exclusive creation is atomic.
 * @complexity O(text bytes), bounded by the fixed credential/endpoint schemas at callers.
 */
async function writePrivateFile(required: { fs: LocalFilesystem; path: string; text: string; exclusive?: true }): Promise<void> {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW
        | (required.exclusive ? constants.O_EXCL : constants.O_TRUNC);
    const file = await required.fs.open(required.path, flags, 0o600);
    try {
        await file.chmod(0o600);
        await file.writeFile(required.text, 'utf8');
    } finally { await file.close(); }
}

/** Provision once per state root; an existing invalid file fails closed instead of rotating authority.
 * @example await provisionLocalOwner({ fs, stateRoot, ids, randomToken });
 * @returns Persistent UUID scope and random owner token, or a stable I/O/validation failure.
 * @complexity O(1), at most 4096 credential bytes and one exclusive creation.
 */
export async function provisionLocalOwner(required: {
    fs: LocalFilesystem; stateRoot: string; ids: IdPort; randomToken: (required: Record<string, never>) => string;
}): Promise<Outcome<LocalCredentials>> {
    try {
        await required.fs.mkdir(required.stateRoot, { recursive: true, mode: 0o700 });
        await required.fs.chmod(required.stateRoot, 0o700);
        const path = join(required.stateRoot, 'owner.json');
        await createOwnerFile({ ...required, path });
        return await readLocalOwner({ fs: required.fs, stateRoot: required.stateRoot });
    } catch { return localFailure({ message: 'Could not provision private local owner credentials' }); }
}

/** Exclusive creation tolerates only an existing owner file; invalid existing authority is read separately. */
async function createOwnerFile(required: { fs: LocalFilesystem; path: string; ids: IdPort; randomToken: (required: Record<string, never>) => string }): Promise<void> {
    try {
        const credentials = credentialsSchema.parse({ token: required.randomToken({}), ownerId: required.ids.next({}), workspaceId: required.ids.next({}) });
        await writePrivateFile({ fs: required.fs, path: required.path, text: JSON.stringify(credentials), exclusive: true });
    } catch (error) {
        if (!z.object({ code: z.literal('EEXIST') }).safeParse(error).success) throw error;
    }
}

/** CLI and server share this bounded credential reader; it never provisions or changes credentials.
 * @returns A validated owner scope/token or an unavailable outcome. @complexity O(1), <=4096 bytes.
 */
export async function readLocalOwner(required: { fs: LocalFilesystem; stateRoot: string }): Promise<Outcome<LocalCredentials>> {
    try {
        const bytes = await readLocalFile({ fs: required.fs, path: join(required.stateRoot, 'owner.json'), maxBytes: 4096, private: true });
        return { ok: true, value: credentialsSchema.parse(JSON.parse(bytes.toString('utf8'))) };
    } catch { return localFailure({ message: 'Local owner credentials are missing, invalid, or not private (0600)' }); }
}

/** Publish the actual ephemeral port for the local CLI; contains no credential or bootstrap token.
 * Native errors propagate to boot cleanup; stale endpoints simply fail the CLI HTTP request.
 */
export async function writeLocalEndpoint(required: { fs: LocalFilesystem; stateRoot: string; serverUrl: string }): Promise<void> {
    const endpoint = endpointSchema.parse({ serverUrl: required.serverUrl });
    await writePrivateFile({ fs: required.fs, path: join(required.stateRoot, 'server.json'), text: JSON.stringify(endpoint) });
}

/** Read discovery metadata when OM_SERVER_URL is absent; never use it for remote authentication.
 * @returns A validated loopback origin or an unavailable failure. @complexity O(1), <=4096 bytes.
 */
export async function readLocalEndpoint(required: { fs: LocalFilesystem; stateRoot: string }): Promise<Outcome<string>> {
    try {
        const bytes = await readLocalFile({ fs: required.fs, path: join(required.stateRoot, 'server.json'), maxBytes: 4096, private: true });
        return { ok: true, value: endpointSchema.parse(JSON.parse(bytes.toString('utf8'))).serverUrl };
    } catch { return localFailure({ message: 'Local server discovery is unavailable; start om:serve or set OM_SERVER_URL' }); }
}

/** Share one default state-root decision between launchers. Boot validates the resolved absolute path. */
export function localStateRoot(required: { env: Readonly<Record<string, string | undefined>>; home: string }): string {
    return required.env.OM_STATE_ROOT ?? join(required.home, '.open-marketing');
}

/** Validate before opening resources; local boot has no production or non-loopback variant. */
export function parseLocalEnvironment(required: { env: Readonly<Record<string, string | undefined>> }): Outcome<{ stateRoot: string; host: '127.0.0.1'; port: number; timezone: string }> {
    const schema = z.strictObject({
        mode: z.literal('local-sandbox'),
        stateRoot: z.string().min(1).max(4096).refine(isAbsolute).refine(value => value !== '/').refine(value => !value.includes('\0')),
        host: z.literal('127.0.0.1'), port: z.string().regex(/^\d{1,5}$/).transform(Number).pipe(z.number().int().min(0).max(65535)),
        timezone: z.string().min(1).max(64).refine(value => isTimeZone({ value })),
    });
    const parsed = schema.safeParse({ mode: required.env.OM_MODE ?? 'local-sandbox', stateRoot: required.env.OM_STATE_ROOT,
        host: required.env.OM_HOST ?? '127.0.0.1', port: required.env.OM_PORT ?? '0', timezone: required.env.OM_TIMEZONE ?? 'UTC' });
    if (!parsed.success) return localFailure({ code: 'invalid_input', message: 'Local boot requires an absolute OM_STATE_ROOT, OM_MODE=local-sandbox, OM_HOST=127.0.0.1 and OM_PORT=0..65535' });
    return { ok: true, value: parsed.data };
}

/** Owner allowance resets at local midnight; the executable supplies the host's IANA zone. */
function isTimeZone({ value }: { value: string }): boolean {
    try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}

function sameToken(required: { expected: string; candidate: string | undefined }): boolean {
    if (!required.candidate || !tokenSchema.safeParse(required.candidate).success) return false;
    return timingSafeEqual(Buffer.from(required.expected), Buffer.from(required.candidate));
}

function bearerToken(required: { authorization: string | undefined }): string | undefined {
    return required.authorization?.startsWith('Bearer ') ? required.authorization.slice(7) : undefined;
}

/** Cookie names include the loopback port because browsers share cookies across ports.
 * Independent state roots can therefore share a browser; duplicates still fail closed. */
function cookieToken(required: { cookie: string | undefined; origin: string }): string | undefined {
    const prefix = `om_owner_${new URL(required.origin).port}=`;
    const matches = (required.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(prefix));
    return matches.length === 1 ? matches[0].slice(prefix.length) : undefined;
}

/** Compare Host and any supplied Origin exactly; cookie mutations require a same-origin Origin. */
function sameOrigin(required: { request: HttpRequest; origin: string; cookie: boolean }): boolean {
    const headers = required.request.headers ?? {};
    if (headers.host !== new URL(required.origin).host) return false;
    if (headers.origin !== undefined && headers.origin !== required.origin) return false;
    return !(required.cookie && required.request.method === 'POST' && headers.origin !== required.origin);
}

/** Inert auth instance. Browser bootstrap is single-use, expires after 60 seconds, and sets the
 * same owner token as an HttpOnly, SameSite=Strict cookie. No durable browser session state exists.
 * @example const auth = createLocalAuth({ credentials, clock, bootstrapToken });
 * @complexity O(header bytes), transport-bounded to 16 KiB; constant instance space.
 */
export function createLocalAuth(required: { credentials: LocalCredentials; clock: ClockPort; bootstrapToken: string }) {
    const bootstrap = tokenSchema.parse(required.bootstrapToken);
    const expiresAt = required.clock.now({}) + 60000;
    let used = false;
    return {
        verify(input: { request: HttpRequest; origin: string }): Outcome<Scope> {
            const cookie = cookieToken({ cookie: input.request.headers?.cookie, origin: input.origin });
            const hasBearer = input.request.authorization !== undefined;
            if (!sameOrigin({ ...input, cookie: !hasBearer && cookie !== undefined })) return localFailure({ code: 'forbidden', message: 'Owner requests must use the local server origin' });
            const candidate = hasBearer ? bearerToken({ authorization: input.request.authorization }) : cookie;
            if (!sameToken({ expected: required.credentials.token, candidate })) return localFailure({ code: 'unauthenticated', message: 'Owner authentication required' });
            return { ok: true, value: { ownerId: required.credentials.ownerId, workspaceId: required.credentials.workspaceId } };
        },
        bootstrap(input: { request: HttpRequest; origin: string }): HttpResponse {
            if (!sameOrigin({ ...input, cookie: false })) return { status: 403, body: localFailure({ code: 'forbidden', message: 'Bootstrap must use the local server origin' }) };
            const valid = input.request.method === 'GET' && !used && required.clock.now({}) < expiresAt
                && sameToken({ expected: bootstrap, candidate: input.request.query?.token });
            if (!valid) return { status: 401, body: localFailure({ code: 'unauthenticated', message: 'Bootstrap is invalid, expired or already used' }) };
            used = true;
            return { status: 303, body: '', contentType: 'text/plain; charset=utf-8', headers: {
                location: '/', 'set-cookie': `om_owner_${new URL(input.origin).port}=${required.credentials.token}; HttpOnly; SameSite=Strict; Path=/`,
                'referrer-policy': 'no-referrer',
            } };
        },
        studioUrl(input: { origin: string }): string { return `${input.origin}/bootstrap?token=${bootstrap}`; },
    };
}
