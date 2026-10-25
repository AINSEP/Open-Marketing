/** HTTP-only add-ons CLI. Native reads are injected; credentials are accepted only from stdin. */
import { parseArgs } from 'node:util';
import { addonKindSchema, addonListRequestSchema, installAddonSchema, connectIntegrationTokenSchema,
  disconnectIntegrationSchema, setAddonEnabledSchema, uninstallAddonSchema, parseBoundary } from '@open-marketing/contracts';
import type { AddonUpload, Outcome } from '@open-marketing/contracts';
import type { CliRuntime } from './types.js';
export type { AddonCliFiles } from './types.js';
import { createSession, failure, requestOm, routes, terminalText } from './http.js';
import type { HttpSession } from './http.js';
import { oauthClientQuerySchema, oauthCallbackSchema, oauthOperationSchema, oauthStartSchema, oauthStatusQuerySchema } from '../integration-oauth-contracts.js';
import { answerApproval } from './approval.js';
import { developerTokenQuerySchema, developerTokenSetSchema, developerTokenStatusSchema } from '../integration-oauth-contracts.js';

const options = { json: { type: 'boolean' }, help: { type: 'boolean' }, kind: { type: 'string' }, limit: { type: 'string' },
  cursor: { type: 'string' }, plugin: { type: 'string' }, connection: { type: 'string' }, 'token-stdin': { type: 'boolean' },
  transaction: { type: 'string' }, 'response-stdin': { type: 'boolean' } } as const;
const help = 'om addons list [--kind plugin|agent-plugin|skill] [--limit 1..100] [--cursor C]\nom addons install <folder|ZIP> [--kind plugin|agent-plugin|skill]\nom addons enable|disable|uninstall <id> --kind plugin|agent-plugin|skill\nom integrations list [--limit 1..100] [--cursor C]\nom integrations connect --plugin <id> [--connection <id>] --token-stdin\nom integrations disconnect <connection-id>\nAll commands: --json, --help\n';
const oauthHelp = 'om integrations oauth client set --plugin ID (stdin JSON: clientId, optional clientSecret)\nom integrations oauth client clear --plugin ID\nom integrations oauth start --plugin ID\nom integrations oauth callback --response-stdin (JSON state + code or error)\nom integrations oauth status --transaction ID | --plugin ID\n';
/** Narrow documented native parseArgs ABI; config stays fixed at this input boundary. */
function nativeArgs(required: { argv: readonly string[] }) {
  return parseArgs({ args: [...required.argv], options, tokens: true, strict: true, allowPositionals: true });
}
type Args = ReturnType<typeof nativeArgs>;

/** Native parser boundary rejects duplicate/irrelevant flags and extra operands before I/O.
 * @complexity O(argv bytes), <=64 arguments and <=64 KiB. Error messages never echo argv.
 */
function parseInput(required: { argv: readonly string[] }): Outcome<Args> {
  if (required.argv.length > 64 || Buffer.byteLength(required.argv.join('\0')) > 65536) return failure({ code: 'limit_exceeded', message: 'CLI input exceeds limits' });
  try {
    const parsed = nativeArgs(required);
    const flags = parsed.tokens!.filter(token => token.kind === 'option').map(token => token.name);
    if (flags.length !== new Set(flags).size) return failure({ code: 'invalid_input', message: 'Repeated flags are not supported' });
    return { ok: true, value: parsed };
  } catch { return failure({ code: 'invalid_input', message: 'Invalid add-on command flags; use --help' }); }
}

/** Validate a fixed command shape. Help still checks irrelevant flags/extra operands. */
function checkedArgs(required: { args: Args; allowed: string[]; count: number }): Outcome<void> {
  const allowed = new Set(['help', 'json', ...required.allowed]);
  if (Object.keys(required.args.values).some(key => !allowed.has(key))) return failure({ code: 'invalid_input', message: 'Unsupported flag for this command' });
  const count = required.args.positionals.length - 2;
  if (count > required.count || (!required.args.values.help && count !== required.count)) return failure({ code: 'invalid_input', message: 'Missing or extra command operands' });
  return { ok: true, value: undefined };
}

/** Bound binary/stdin reads and chunks; dispose the deadline even on input failure.
 * @complexity O(b) time/space, <=32 MiB for ZIP or <=64 KiB for token; one injected read.
 */
async function readBytes(required: { runtime: CliRuntime; path: string; maxBytes: number }): Promise<Outcome<Buffer>> {
  const deadline = required.runtime.deadline.create({ timeoutMs: 15000 });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    const signal = required.runtime.signal ? AbortSignal.any([deadline.signal, required.runtime.signal]) : deadline.signal;
    for await (const chunk of required.runtime.readPrompt({ path: required.path, signal })) {
      size += chunk.byteLength;
      if (size > required.maxBytes || chunks.length >= 65536 || signal.aborted) return failure({ code: 'limit_exceeded', message: 'Input exceeds size/deadline limits' });
      chunks.push(Uint8Array.from(chunk));
    }
    if (signal.aborted) return failure({ code: 'cancelled', message: 'Input read cancelled' });
    return { ok: true, value: Buffer.concat(chunks, size) };
  } catch { return failure({ code: 'invalid_input', message: 'Upload or stdin could not be read' }); }
  finally { deadline.dispose({}); }
}

/** Folder/ZIP go to the same wire upload; Jini on the server owns package interpretation. */
async function install(required: { args: Args; runtime: CliRuntime; session: HttpSession }): Promise<Outcome<unknown>> {
  const path = required.args.positionals[2];
  let upload: AddonUpload;
  if (/\.zip$/i.test(path)) {
    const bytes = await readBytes({ runtime: required.runtime, path, maxBytes: 33554432 });
    if (!bytes.ok) return bytes;
    upload = { kind: 'zip', base64: bytes.value.toString('base64') };
  } else {
    const folder = await readFolder({ runtime: required.runtime, path });
    if (!folder.ok) return folder;
    upload = folder.value;
  }
  const body = parseBoundary({ schema: installAddonSchema, input: { upload, kind: required.args.values.kind } });
  return body.ok ? requestOm({ session: required.session, route: routes.addonInstall, body: body.value }) : failure({ code: 'invalid_input', message: 'Invalid upload or add-on kind' });
}

/** Folder reads stay behind the injected reader and share the CLI deadline/abort signal. */
async function readFolder(required: { runtime: CliRuntime; path: string }): Promise<Outcome<AddonUpload>> {
  if (!required.runtime.addonFiles) return failure({ code: 'unavailable', message: 'Folder reader unavailable; upload a ZIP instead' });
  const deadline = required.runtime.deadline.create({ timeoutMs: 15000 });
  try { return { ok: true, value: await required.runtime.addonFiles.readFolder({ path: required.path, signal: required.runtime.signal ? AbortSignal.any([deadline.signal, required.runtime.signal]) : deadline.signal }) }; }
  catch { return failure({ code: 'invalid_input', message: 'Folder upload refused or unreadable' }); }
  finally { deadline.dispose({}); }
}

/** Decode stdin as UTF-8 without trimming submitted credentials; never print/store the secret. */
async function connect(required: { args: Args; runtime: CliRuntime; session: HttpSession }): Promise<Outcome<unknown>> {
  if (!required.args.values['token-stdin']) return failure({ code: 'invalid_input', message: 'Connect requires --token-stdin; token arguments are not accepted' });
  const bytes = await readBytes({ runtime: required.runtime, path: '-', maxBytes: 65536 });
  if (!bytes.ok) return bytes;
  try {
    const body = connectIntegrationTokenSchema.safeParse({ pluginId: required.args.values.plugin,
      connectionId: required.args.values.connection ?? required.runtime.ids.next({}), plaintext: new TextDecoder('utf-8', { fatal: true }).decode(bytes.value) });
    if (!body.success) return failure({ code: 'invalid_input', message: 'Invalid plugin, connection ID, or token' });
    return requestOm({ session: required.session, route: routes.integrationConnect, body: body.data });
  } catch { return failure({ code: 'invalid_input', message: 'Token stdin must be UTF-8' }); }
}

/** Shared list query validation for add-ons and integrations. */
async function list(required: { args: Args; session: HttpSession; key: string }): Promise<Outcome<unknown>> {
  const values = required.args.values;
  if (values.limit !== undefined && !/^\d{1,3}$/.test(values.limit)) return failure({ code: 'invalid_input', message: 'Limit must be an integer from 1 to 100' });
  const query = addonListRequestSchema.safeParse({ limit: Number(values.limit ?? 25), cursor: values.cursor, kind: values.kind });
  if (!query.success) return failure({ code: 'invalid_input', message: 'Invalid list query' });
  if (required.key === 'addons list') return requestOm({ session: required.session, route: routes.addons, query: query.data });
  return requestOm({ session: required.session, route: routes.integrations, query: query.data });
}

/** Fixed endpoint parity for lifecycle operations, with validated bodies/receipts. */
async function dispatch(required: { args: Args; session: HttpSession; runtime: CliRuntime }): Promise<Outcome<unknown>> {
  const key = required.args.positionals.slice(0, 2).join(' ');
  const values = required.args.values;
  switch (key) {
    case 'integrations oauth': return oauth(required);
    case 'integrations developer-token': return developerToken(required);
    case 'addons list': case 'integrations list': return list({ ...required, key });
    case 'addons install': return install(required);
    case 'addons enable': case 'addons disable': {
      const body = setAddonEnabledSchema.safeParse({ kind: values.kind, id: required.args.positionals[2], enabled: key === 'addons enable' });
      return body.success ? requestOm({ session: required.session, route: routes.addonSetEnabled, body: body.data }) : failure({ code: 'invalid_input', message: 'Specify an ID and --kind' });
    }
    case 'addons uninstall': {
      const body = uninstallAddonSchema.safeParse({ kind: values.kind, id: required.args.positionals[2] });
      return body.success ? requestOm({ session: required.session, route: routes.addonUninstall, body: body.data }) : failure({ code: 'invalid_input', message: 'Specify an ID and --kind' });
    }
    case 'integrations connect': return connect(required);
    case 'integrations disconnect': {
      const body = disconnectIntegrationSchema.safeParse({ connectionId: required.args.positionals[2] });
      return body.success ? requestOm({ session: required.session, route: routes.integrationDisconnect, body: body.data }) : failure({ code: 'invalid_input', message: 'Specify a connection ID' });
    }
    default: return failure({ code: 'invalid_input', message: 'Unknown add-on command; use --help' });
  }
}

/** Command validation precedes session/read effects; management failures never expose server bodies. */
async function run(required: { args: Args; runtime: CliRuntime }): Promise<Outcome<unknown>> {
  const key = required.args.positionals.slice(0, 2).join(' ');
  const shapes: Record<string, { count: number; allowed: string[] }> = {
    'addons list': { count: 0, allowed: ['kind', 'limit', 'cursor'] },
    'addons install': { count: 1, allowed: ['kind'] },
    'addons enable': { count: 1, allowed: ['kind'] }, 'addons disable': { count: 1, allowed: ['kind'] },
    'addons uninstall': { count: 1, allowed: ['kind'] },
    'integrations list': { count: 0, allowed: ['limit', 'cursor'] },
    'integrations connect': { count: 0, allowed: ['plugin', 'connection', 'token-stdin'] },
    'integrations disconnect': { count: 1, allowed: [] },
    'integrations developer-token': { count: 1, allowed: ['plugin'] },
    'integrations oauth': { count: required.args.positionals[2] === 'client' ? 2 : 1, allowed: oauthFlags[required.args.positionals[2]] ?? [] },
  };
  if (required.args.positionals.length === 1 && required.args.values.help) return { ok: true, value: { help } };
  const shape = shapes[key];
  if (!shape) return failure({ code: 'invalid_input', message: 'Unknown add-on command; use --help' });
  const checked = checkedArgs({ args: required.args, ...shape });
  if (!checked.ok) return checked;
  if (required.args.values.help) return { ok: true, value: { help } };
  if (required.args.values.kind !== undefined && !addonKindSchema.safeParse(required.args.values.kind).success) return failure({ code: 'invalid_input', message: 'Invalid add-on kind' });
  const session = createSession({ runtime: required.runtime });
  if (!session.ok) return session;
  const result = await dispatch({ ...required, session: session.value });
  return result.ok ? result : failure({ code: result.error.code, message: 'Add-on operation failed (' + result.error.code + '). Refresh server state before another submission.' });
}

/** Delegate one CLI family to the existing authenticated transport, printing secret-free Outcomes.
 * @example await runAddonCli({ argv: ['integrations', 'connect', '--plugin', 'anthropic', '--token-stdin'], runtime });
 * @complexity Bounded argv/upload/response; one HTTP write, no retries or vendor effects.
 */
export async function runAddonCli(required: { argv: readonly string[]; runtime: CliRuntime }): Promise<Outcome<void>> {
  const parsed = parseInput(required);
  let result: Outcome<unknown>;
  try { result = parsed.ok ? await run({ args: parsed.value, runtime: required.runtime }) : parsed; }
  catch { result = failure({ code: 'unavailable', message: 'Add-on command failed; refresh server state before another submission' }); }
  const json = required.argv.includes('--json');
  if (json) required.runtime.stdout.write({ text: JSON.stringify(result) + '\n' });
  else if (result.ok && parsed.ok && parsed.value.values.help) required.runtime.stdout.write({ text: help + oauthHelp + 'om integrations developer-token set|clear|status --plugin google-ads (set reads the token from stdin)\n' });
  else if (result.ok) required.runtime.stdout.write({ text: terminalText({ text: JSON.stringify(result.value) }) + '\n' });
  else required.runtime.stderr.write({ text: result.error.message + '\n' });
  return result.ok ? { ok: true, value: undefined } : result;
}

const oauthFlags: Record<string, string[]> = { client: ['plugin'], start: ['plugin'], callback: ['response-stdin'], status: ['transaction', 'plugin'] };
/** Owner-only Google compatibility secret; bounded UTF-8 stdin, no argv secret or echo. */
async function developerToken(required: { args: Args; runtime: CliRuntime; session: HttpSession }): Promise<Outcome<unknown>> {
  const query = developerTokenQuerySchema.safeParse({ pluginId: required.args.values.plugin });
  const action = required.args.positionals[2];
  if (!query.success || !['set', 'clear', 'status'].includes(action)) return failure({ code: 'invalid_input', message: 'Specify developer-token set|clear|status --plugin google-ads' });
  const route = { path: '/api/addons/v1/integrations/developer-token', schema: developerTokenStatusSchema };
  if (action === 'status') return requestOm({ session: required.session, route: { ...route, method: 'GET' }, query: query.data });
  let token: string | null = null;
  if (action === 'set') {
    const bytes = await readBytes({ runtime: required.runtime, path: '-', maxBytes: 64 });
    if (!bytes.ok) return bytes;
    try { token = new TextDecoder('utf-8', { fatal: true }).decode(bytes.value).replace(/\r?\n$/, ''); }
    catch { return failure({ code: 'invalid_input', message: 'Token stdin must be UTF-8' }); }
  }
  const body = developerTokenSetSchema.safeParse({ ...query.data, token });
  return body.success ? requestOm({ session: required.session, route: { ...route, method: 'POST' }, body: body.data }) : failure({ code: 'invalid_input', message: 'Invalid developer token' });
}
/** Fixed command schemas before stdin/HTTP; callback secrets travel only in the authenticated body.
 * Start uses the same exact-card terminal continuation as ordinary tool calls; JSON returns its receipt.
 * @complexity <=64 KiB stdin, one dispatch plus bounded approval continuation; no retries.
 */
async function oauth(required: { args: Args; runtime: CliRuntime; session: HttpSession }): Promise<Outcome<unknown>> {
  const values = required.args.values;
  switch (required.args.positionals[2]) {
    case 'client': return oauthClient(required);
    case 'start': {
      const body = oauthStartSchema.safeParse({ pluginId: values.plugin });
      if (!body.success) return failure({ code: 'invalid_input', message: 'Specify --plugin ID' });
      const result = await requestOm({ session: required.session, route: routes.integrationOAuthStart, body: body.data });
      if (!result.ok || result.value.status !== 'pending' || values.json || !result.value.cardId) return result;
      const answered = await answerApproval({ ...required, cardId: result.value.cardId, choice: 'allow' });
      return answered.ok ? requestOm({ session: required.session, route: { ...routes.toolOperation, schema: oauthOperationSchema }, id: result.value.operationId }) : answered;
    }
    case 'status': {
      const query = oauthStatusQuerySchema.safeParse(Object.fromEntries(Object.entries({ transactionId: values.transaction, pluginId: values.plugin }).filter(([, value]) => value !== undefined)));
      return query.success ? requestOm({ session: required.session, route: routes.integrationOAuthStatus, query: query.data }) : failure({ code: 'invalid_input', message: 'Specify exactly one of --transaction ID or --plugin ID' });
    }
    case 'callback': {
      return oauthCallback(required);
    }
    default: return failure({ code: 'invalid_input', message: 'Unknown OAuth command; use --help' });
  }
}

/** Owner-only client ingress; credentials are bounded stdin JSON, never argv or output. @complexity <=64 KiB, one HTTP call. */
async function oauthClient(required: { args: Args; runtime: CliRuntime; session: HttpSession }): Promise<Outcome<unknown>> {
  const plugin = oauthClientQuerySchema.safeParse({ pluginId: required.args.values.plugin });
  const action = required.args.positionals[3];
  if (!plugin.success || !['set', 'clear'].includes(action)) return failure({ code: 'invalid_input', message: 'Specify client set|clear --plugin ID' });
  if (action === 'clear') return requestOm({ session: required.session, route: routes.integrationOAuthClient, body: { ...plugin.data, client: null } });
  const bytes = await readBytes({ runtime: required.runtime, path: '-', maxBytes: 65536 });
  if (!bytes.ok) return bytes;
  try { return requestOm({ session: required.session, route: routes.integrationOAuthClient, body: { ...plugin.data, client: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.value)) } }); }
  catch { return failure({ code: 'invalid_input', message: 'Client stdin must be JSON' }); }
}

/** Read one bounded JSON response from stdin; tainted errors/codes never reach terminal output. */
async function oauthCallback(required: { args: Args; runtime: CliRuntime; session: HttpSession }): Promise<Outcome<unknown>> {
  if (!required.args.values['response-stdin']) return failure({ code: 'invalid_input', message: 'Callback requires --response-stdin' });
  const bytes = await readBytes({ runtime: required.runtime, path: '-', maxBytes: 65536 });
  if (!bytes.ok) return bytes;
  try {
    const body = oauthCallbackSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.value)));
    return body.success ? requestOm({ session: required.session, route: routes.integrationOAuthCallback, body: body.data }) : failure({ code: 'invalid_input', message: 'Invalid OAuth response' });
  } catch { return failure({ code: 'invalid_input', message: 'OAuth stdin must be JSON' }); }
}
