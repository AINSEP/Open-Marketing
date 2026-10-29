import { readBytes, runAddonCli } from './addons.js';
import type { CliRuntime } from './types.js';
export type { CliRuntime } from './types.js';
/** Inert owner CLI: terminal commands use HTTP, never features, DB, or vendor configuration. */
import { parseArgs } from "node:util";
import { basename } from "node:path";
import { z } from "zod";
import { approvalChoiceSchema, boundedJsonSchema, chatAttachmentSchema, digestSchema, idSchema, pageQuerySchema, parseBoundary, toolCallSchema } from "@open-marketing/contracts";
import type { ApprovalResponse, ChatAttachmentRef, Outcome, PageQuery, RunEvent } from "@open-marketing/contracts";
import { answerApproval, readCard } from "./approval.js";
import { createSession, failure, requestOm, routes, terminalText } from "./http.js";
import type { HttpSession } from "./http.js";

const options = {
  json: { type: "boolean" }, help: { type: "boolean" }, limit: { type: "string" },
  cursor: { type: "string" }, choice: { type: "string" }, account: { type: "string" },
  attach: { type: "string", multiple: true },
  "input-file": { type: "string" }, "confirm-digest": { type: "string" }, "prompt-file": { type: "string" }, conversation: { type: "string" },
} as const;
type Values = ReturnType<typeof parseCliArgs>["values"];
type Command =
  | { name: "help" | "status" | "allowance" }
  | { name: "campaigns" | "approvals"; query: PageQuery }
  | { name: "campaign"; id: string }
  | { name: "answer"; cardId: string; choice: ApprovalResponse["choice"]; confirmDigest?: string }
  | { name: "halt"; accountId: string }
  | { name: "tools-list"; query: PageQuery }
  | { name: "tools-show"; id: string }
  | { name: "tools-call"; id: string; inputFile: string }
  | { name: "ask"; prompt?: string; promptFile?: string; conversationId?: string; attach?: string[] };

const help = [
  "om status", "om campaigns list [--limit 1..100] [--cursor C]", "om campaigns show <id>",
  "om approvals list [--limit 1..100] [--cursor C]",
  "om approvals answer <card-id> --choice <allow|allow_chat|always_allow|cancel> [--confirm-digest <digest>]",
  "om ads halt --account <id>", "om settings generation show",
  "om ask <prompt> [--conversation <id>] [--attach <file> ...] | om ask --prompt-file <path|-> [--conversation <id>] [--attach <file> ...] (up to 4 PNG/JPEG/WebP images, 1 MiB each)", "All commands: --json, --help",
  "om tools list [--limit 1..100]", "om tools show <name>", "om tools call <name> --input-file <path|->",
  "Tool calls use the server policy. Text mode displays/answers its exact card; --json returns a pending receipt.",
  "om addons list|install|enable|disable|uninstall --help", "om integrations list|connect|disconnect --help",
  "Set OM_SERVER_URL and OM_OWNER_TOKEN (owner session, not agent service credentials).",
  "Approval answers display the current card and require explicit confirmation. The server records answers and continues the frozen operation when applicable.",
  "Ask polls the selected server assistant mode. --json returns one run receipt. Ctrl-C cancels the run.",
].join("\n") + "\n";

// Dot-only IDs would be normalized as URL path traversal even after percent encoding.
const pathId = idSchema.refine(value => value !== "." && value !== "..");
const askInput = z.strictObject({
  prompt: z.string().min(1).max(65536).optional(), promptFile: z.string().min(1).max(4096).optional(), conversationId: pathId.optional(),
  attach: z.array(z.string().min(1).max(4096).refine(path => path !== "-")).min(1).max(4).optional(),
}).refine(value => (value.prompt === undefined) !== (value.promptFile === undefined));

/** Narrow native parseArgs wrapper; throws are converted at the CLI input boundary. */
function parseCliArgs(required: { argv: readonly string[] }) {
  return parseArgs({ args: [...required.argv], options, allowPositionals: true, strict: true, tokens: true });
}

/** Reject duplicate/irrelevant options and extra operands before command-specific schema parsing.
 * Help skips required inputs but still rejects extra operands and irrelevant flags.
 * @complexity O(option count) time/space, bounded to 64 argv entries.
 */
function commandInput<N extends Command["name"], T extends object>(required: {
  name: N; values: Values; allowed: readonly string[]; operands: readonly string[]; count: number;
  schema: z.ZodType<T>; input: unknown;
}): Outcome<{ name: "help" } | (T & { name: N })> {
  const relevant = new Set(["json", "help", ...required.allowed]);
  if (Object.keys(required.values).some(key => !relevant.has(key))) return failure({ code: "invalid_input", message: "Flag is not supported by this command" });
  if (required.operands.length > required.count) return failure({ code: "invalid_input", message: "Extra command operands; use --help" });
  if (required.values.help) return { ok: true, value: { name: "help" } };
  if (required.operands.length !== required.count) return failure({ code: "invalid_input", message: "Missing or extra command operands; use --help" });
  const parsed = parseBoundary({ schema: required.schema, input: required.input });
  if (!parsed.ok) return failure({ code: "invalid_input", message: "Invalid command arguments; use --help" });
  return { ok: true, value: { name: required.name, ...parsed.value } };
}

/** Recognize the small fixed surface without a command registry or extensibility layer. */
function commandName(required: { positionals: readonly string[] }): Outcome<{ name: Command["name"]; operands: readonly string[] }> {
  const root = required.positionals[0];
  let count = 2;
  if (root === "settings") count = 3;
  if (root === "status" || root === "ask") count = 1;
  const key = required.positionals.slice(0, count).join(" ");
  const operands = required.positionals.slice(count);
  switch (key) {
    case "": return { ok: true, value: { name: "help", operands } };
    case "status": return { ok: true, value: { name: "status", operands } };
    case "campaigns list": return { ok: true, value: { name: "campaigns", operands } };
    case "campaigns show": return { ok: true, value: { name: "campaign", operands } };
    case "approvals list": return { ok: true, value: { name: "approvals", operands } };
    case "approvals answer": return { ok: true, value: { name: "answer", operands } };
    case "ads halt": return { ok: true, value: { name: "halt", operands } };
    case "settings generation show": return { ok: true, value: { name: "allowance", operands } };
    case "tools list": return { ok: true, value: { name: "tools-list", operands } };
    case "tools show": return { ok: true, value: { name: "tools-show", operands } };
    case "tools call": return { ok: true, value: { name: "tools-call", operands } };
    case "ask": return { ok: true, value: { name: "ask", operands } };
    default: return failure({ code: "invalid_input", message: "Unknown command; use om --help" });
  }
}

const pageInput = z.strictObject({
  limit: z.string().regex(/^\d+$/).default("25").transform(Number), cursor: idSchema.optional(),
}).pipe(pageQuerySchema);

/** Validate the selected command; successful parsing is the only way to reach dispatch. */
function buildCommand(required: { name: Command["name"]; operands: readonly string[]; values: Values }): Outcome<Command> {
  const { name, operands, values } = required;
  switch (name) {
    case "help": case "status": case "allowance":
      return commandInput({ ...required, name, allowed: [], count: 0, schema: z.strictObject({}), input: {} });
    case "campaigns": case "approvals":
      return commandInput({ ...required, name, allowed: ["limit", "cursor"], count: 0,
        schema: z.strictObject({ query: pageInput }), input: { query: { limit: values.limit, cursor: values.cursor } } });
    case "tools-list":
      return commandInput({ ...required, name, allowed: ["limit"], count: 0, schema: z.strictObject({ query: pageInput }), input: { query: { limit: values.limit ?? "100" } } });
    case "tools-show":
      return commandInput({ ...required, name, allowed: [], count: 1, schema: z.strictObject({ id: pathId }), input: { id: operands[0] } });
    case "tools-call":
      return commandInput({ ...required, name, allowed: ["input-file"], count: 1, schema: z.strictObject({ id: pathId, inputFile: z.string().min(1).max(4096) }), input: { id: operands[0], inputFile: values["input-file"] } });
    case "campaign":
      return commandInput({ ...required, name, allowed: [], count: 1,
        schema: z.strictObject({ id: pathId }), input: { id: operands[0] } });
    case "answer":
      return commandInput({ ...required, name, allowed: ["choice", "confirm-digest"], count: 1,
        schema: z.strictObject({ cardId: pathId, choice: approvalChoiceSchema, confirmDigest: digestSchema.optional() }),
        input: { cardId: operands[0], choice: values.choice, confirmDigest: values["confirm-digest"] } });
    case "halt":
      return commandInput({ ...required, name, allowed: ["account"], count: 0,
        schema: z.strictObject({ accountId: idSchema }), input: { accountId: values.account } });
    case "ask":
      return commandInput({ ...required, name, allowed: ["prompt-file", "conversation", "attach"], count: values["prompt-file"] === undefined ? 1 : 0,
        schema: askInput, input: { prompt: operands[0], promptFile: values["prompt-file"], conversationId: values.conversation, attach: values.attach } });
    default: { const exhaustive: never = name; return exhaustive; }
  }
}

/** Parse strict native flags, rejecting ambiguous duplicates and bounded input before any I/O.
 * @complexity O(argv bytes) time/space, <=64 entries and <=64 KiB.
 */
function parseCommand(required: { argv: readonly string[] }): Outcome<{ command: Command; json: boolean }> {
  if (required.argv.length > 64 || new TextEncoder().encode(required.argv.join("\0")).byteLength > 65536) {
    return failure({ code: "limit_exceeded", message: "CLI arguments exceed 64 entries or 64 KiB" });
  }
  try {
    const args = parseCliArgs(required);
    const names = args.tokens.filter(token => token.kind === "option").map(token => token.name).filter(name => name !== "attach");
    if (new Set(names).size !== names.length) return failure({ code: "invalid_input", message: "Repeated flags are not supported" });
    const identified = commandName({ positionals: args.positionals });
    if (!identified.ok) return identified;
    const command = buildCommand({ ...identified.value, values: args.values });
    if (!command.ok) return command;
    return { ok: true, value: { command: command.value, json: args.values.json ?? false } };
  } catch {
    return failure({ code: "invalid_input", message: "Invalid or unknown flags; use om --help" });
  }
}

/** Read file/stdin incrementally; never load more than 64 KiB or silently truncate a prompt.
 * @returns Plain UTF-8 text or a typed input/size error; always disposes the injected deadline.
 * @complexity O(n) time/space, n <=64 KiB; one injected read, no HTTP.
 */
async function readPrompt(required: { runtime: CliRuntime; path: string }): Promise<Outcome<string>> {
  const deadline = required.runtime.deadline.create({ timeoutMs: 15000 });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let prompt = "";
  try {
    for await (const chunk of required.runtime.readPrompt({ path: required.path, signal: deadline.signal })) {
      bytes += chunk.byteLength;
      if (bytes > 65536) return failure({ code: "limit_exceeded", message: "Prompt exceeds 64 KiB" });
      prompt += decoder.decode(chunk, { stream: true });
    }
    return { ok: true, value: prompt + decoder.decode() };
  } catch {
    return failure({ code: "invalid_input", message: "Prompt file/stdin could not be read as UTF-8" });
  } finally {
    deadline.dispose({});
  }
}

/** Parse bounded JSON file/stdin before generating a stable operation identity or sending HTTP.
 * Tool JSON is data; file paths and approval authority never reach a feature or vendor directly.
 */
async function toolInput(required: { runtime: CliRuntime; path: string }): Promise<Outcome<z.infer<typeof boundedJsonSchema>>> {
  if (required.runtime.signal?.aborted) return failure({ code: 'cancelled', message: 'Tool call cancelled before dispatch' });
  const text = await readPrompt(required);
  if (!text.ok) return text;
  try { return parseBoundary({ schema: boundedJsonSchema, input: JSON.parse(text.value) as unknown }); }
  catch { return failure({ code: 'invalid_input', message: 'Tool input must contain one bounded JSON value' }); }
}

/** Human tool calls use the existing fetch/display/confirm/answer flow and return the actual
 * operation result. JSON mode returns the receipt; owner approval commands can continue it.
 * @complexity <=64 KiB input, one dispatch and at most three continuation HTTP calls; no retries.
 */
async function callTool(required: { command: Extract<Command, { name: 'tools-call' }>; session: HttpSession; runtime: CliRuntime; json: boolean }): Promise<Outcome<unknown>> {
  const input = await toolInput({ runtime: required.runtime, path: required.command.inputFile });
  if (!input.ok) return input;
  const call = parseBoundary({ schema: toolCallSchema, input: { name: required.command.id, input: input.value, operationId: required.runtime.ids.next({}) } });
  if (!call.ok) return call;
  // An uncertain POST keeps this identity visible for reconciliation; it is never retried here.
  required.runtime.stderr.write({ text: 'Tool operation: ' + terminalText({ text: call.value.operationId }) + '\n' });
  const dispatched = await requestOm({ session: required.session, route: routes.callTool, body: call.value, signal: required.runtime.signal });
  if (!dispatched.ok) return dispatched;
  if (dispatched.value.status !== 'pending' || required.json) return dispatched;
  return continueToolCall({ ...required, receipt: dispatched.value });
}

/** Exact Allow is chosen only after the injected terminal confirmation, never by --json.
 * A pending/unknown receipt remains queryable rather than becoming fabricated completion.
 */
async function continueToolCall(required: { session: HttpSession; runtime: CliRuntime; receipt: Extract<z.infer<typeof routes.callTool.schema>, { status: 'pending' }> }): Promise<Outcome<unknown>> {
  if (!required.receipt.cardId) return { ok: true, value: required.receipt };
  const answered = await answerApproval({ session: required.session, runtime: required.runtime, cardId: required.receipt.cardId, choice: 'allow' });
  if (!answered.ok) return answered;
  const operation = await requestOm({ session: required.session, route: routes.toolOperation, id: required.receipt.operationId, signal: required.runtime.signal });
  if (!operation.ok) return operation;
  switch (operation.value.status) {
    case 'completed': return { ok: true, value: { status: 'completed', output: operation.value.output } };
    case 'pending': return { ok: true, value: operation.value };
    case 'unknown': return { ok: false, error: { ...operation.value.error, retryable: false } };
    case 'cancelled': return failure({ code: 'cancelled', message: 'Tool operation cancelled' });
    case 'interrupted': return failure({ code: 'expired', message: 'Tool operation interrupted; request fresh authority' });
    default: { const exhaustive: never = operation.value; return exhaustive; }
  }
}

/** Upload explicit files sequentially; the server sniffs and admits image bytes.
 * Returns validated refs or the first failure; earlier uploads remain saved, and no retries run.
 * @complexity O(total bytes) time, O(largest file + ref count) space; <=4 files, <=1 MiB each,
 * one bounded read and one deadline-bound HTTP upload per file.
 */
async function uploadAttachments(required: { session: HttpSession; runtime: CliRuntime; paths: readonly string[] }): Promise<Outcome<ChatAttachmentRef[]>> {
  const attachments: ChatAttachmentRef[] = [];
  for (const path of required.paths) {
    const name = chatAttachmentSchema.shape.name.safeParse(basename(path));
    if (!name.success) return failure({ code: 'invalid_input', message: 'Invalid attachment file name' });
    const bytes = await readBytes({ runtime: required.runtime, path, maxBytes: 1048576 });
    if (!bytes.ok) return bytes;
    const uploaded = await requestOm({ session: required.session, route: routes.uploadAttachment, query: { name: name.data }, rawBody: bytes.value, signal: required.runtime.signal });
    if (!uploaded.ok) return uploaded;
    attachments.push(uploaded.value);
  }
  return { ok: true, value: attachments };
}

/** Validate prompt text and upload any images before starting a run; a failed batch starts none.
 * Server owns run IDs, grants, image admission, agent configuration, and lifecycle.
 */
async function ask(required: { command: Extract<Command, { name: "ask" }>; session: HttpSession; runtime: CliRuntime }): Promise<Outcome<z.infer<typeof routes.ask.schema>>> {
  let prompt = required.command.prompt ?? "";
  if (required.command.promptFile !== undefined) {
    const read = await readPrompt({ runtime: required.runtime, path: required.command.promptFile });
    if (!read.ok) return read;
    prompt = read.value;
  }
  if (!prompt.trim()) return failure({ code: "invalid_input", message: "Prompt must contain text" });
  if (new TextEncoder().encode(prompt).byteLength > 65536) return failure({ code: "limit_exceeded", message: "Prompt exceeds 64 KiB" });
  let attachments: ChatAttachmentRef[] | undefined;
  if (required.command.attach) {
    const uploaded = await uploadAttachments({ session: required.session, runtime: required.runtime, paths: required.command.attach });
    if (!uploaded.ok) return uploaded;
    attachments = uploaded.value;
  }
  return requestOm({ session: required.session, route: routes.ask, body: { prompt, conversationId: required.command.conversationId, attachments } });
}

/** Poll spacing is an injected timer/deadline; total observation and owner interruption abort it. */
async function waitForPoll(required: { runtime: CliRuntime; signal: AbortSignal }): Promise<void> {
  const delay = required.runtime.deadline.create({ timeoutMs: 1000 });
  const signal = AbortSignal.any([delay.signal, required.signal]);
  try { if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); }
  finally { delay.dispose({}); }
}

/** Validate a whole page's identity/ordering before emitting any text to the terminal. */
function checkedPage(required: { page: z.infer<typeof routes.runEvents.schema>; runId: string; after: number; session: HttpSession }): Outcome<number> {
  if (required.page.runId !== required.runId) return failure({ code: 'protocol_mismatch', message: 'Server returned a different run' });
  let sequence = required.after;
  for (const event of required.page.events) {
    if (event.runId !== required.runId || event.sequence !== sequence + 1 || event.correlationId !== required.session.correlationId || event.traceId !== required.session.traceId) return failure({ code: 'protocol_mismatch', message: 'Run event identity or ordering mismatch' });
    sequence = event.sequence;
  }
  if (required.page.status === 'completed' && required.page.events.at(-1)?.kind !== 'ended') return failure({ code: 'protocol_mismatch', message: 'Completed run lacks a terminal event' });
  return { ok: true, value: sequence };
}

/** Event JSON is untrusted at this terminal sink; only bounded text is displayed and controls escape. */
function printRunEvent(required: { runtime: CliRuntime; event: RunEvent }): void {
  if (required.event.kind === 'delta') {
    const payload = z.strictObject({ text: z.string().max(65536) }).safeParse(required.event.payload);
    if (payload.success) required.runtime.stdout.write({ text: terminalText({ text: payload.data.text }) });
    return;
  }
  const newline = required.event.kind === 'ended' ? '\n' : '';
  required.runtime.stdout.write({ text: newline + '[Run] ' + required.event.kind + '\n' });
}

/** Validate/print one complete owner page, preserving explicit cancelled/interrupted outcomes. */
async function observeRunPage(required: { runtime: CliRuntime; session: HttpSession; runId: string; after: number; signal: AbortSignal }): Promise<Outcome<{ after: number; completed: boolean }>> {
  const result = await requestOm({ session: required.session, route: routes.runEvents, id: required.runId, query: { after: required.after }, signal: required.signal });
  if (required.signal.aborted) return failure({ code: 'cancelled', message: 'Run observation interrupted' });
  if (!result.ok) return result;
  const checked = checkedPage({ ...required, page: result.value });
  if (!checked.ok) return checked;
  for (const event of result.value.events) printRunEvent({ runtime: required.runtime, event });
  if (result.value.status !== 'running' && result.value.usage) required.runtime.stdout.write({ text: '[Usage estimate] ' + JSON.stringify(result.value.usage) + '\n' });
  if (result.value.status === 'cancelled') return failure({ code: 'cancelled', message: 'Run cancelled' });
  if (result.value.status === 'interrupted') return failure({ code: 'unavailable', message: 'Run interrupted' });
  return { ok: true, value: { after: checked.value, completed: result.value.status === 'completed' } };
}

async function cancelObservedRun(required: { session: HttpSession; runId: string }): Promise<Outcome<void>> {
  const cancel = await requestOm({ session: required.session, route: routes.cancelRun, id: required.runId, body: {} });
  if (!cancel.ok || cancel.value.runId !== required.runId) return failure({ code: 'unavailable', message: 'Observation stopped; run cancellation unconfirmed' });
  return failure({ code: 'cancelled', message: 'Run observation stopped; run authority revoked' });
}

/** Observe at most 300 pages/30s; writes are never retried. Interruption/timeout revokes the
 * server grant via the owner cancel route. JSON mode skips this path entirely.
 * @complexity <=300 bounded GETs/5 min, <=128 events/page; no retained transcript in the CLI.
 */
async function followRun(required: { runtime: CliRuntime; session: HttpSession; runId: string }): Promise<Outcome<void>> {
  const deadline = required.runtime.deadline.create({ timeoutMs: 300000 });
  const signal = required.runtime.signal ? AbortSignal.any([deadline.signal, required.runtime.signal]) : deadline.signal;
  let after = 0;
  try {
    for (let pages = 0; pages < 300 && !signal.aborted; pages++) {
      const result = await observeRunPage({ ...required, after, signal });
      if (signal.aborted) break;
      if (!result.ok) return result;
      after = result.value.after;
      if (result.value.completed) return { ok: true, value: undefined };
      await waitForPoll({ runtime: required.runtime, signal });
    }
    return cancelObservedRun(required);
  } finally { deadline.dispose({}); }
}

/** Validate all displayed cards before emitting a page; a mixed unsafe page prints no partial data. */
async function listApprovals(required: { session: HttpSession; query: PageQuery }): Promise<Outcome<unknown>> {
  const result = await requestOm({ ...required, route: routes.approvals });
  if (!result.ok) return result;
  for (const card of result.value.items) {
    const validated = readCard({ input: card });
    if (!validated.ok) return validated;
  }
  return result;
}

/** Match single-resource acknowledgements to the requested identifier. */
async function showCampaign(required: { session: HttpSession; id: string }): Promise<Outcome<unknown>> {
  const result = await requestOm({ ...required, route: routes.campaign });
  if (result.ok && result.value.id !== required.id) return failure({ code: "protocol_mismatch", message: "Server returned a different campaign" });
  return result;
}

/** Preserve the server's requested/pending/completed/failed halt status without inventing remote success. */
async function halt(required: { session: HttpSession; accountId: string }): Promise<Outcome<unknown>> {
  const result = await requestOm({ session: required.session, route: routes.halt, body: { accountId: required.accountId } });
  if (result.ok && result.value.accountId !== required.accountId) return failure({ code: "protocol_mismatch", message: "Halt receipt account mismatch; read server state before another submission" });
  return result;
}

/** One exhaustive dispatch; no command bypasses the shared HTTP boundary. */
async function dispatch(required: { command: Command; session: HttpSession; runtime: CliRuntime; json: boolean }): Promise<Outcome<unknown>> {
  const { command, session, runtime } = required;
  switch (command.name) {
    case "help": return { ok: true, value: { help } };
    case "tools-list": return requestOm({ session, route: routes.tools, query: command.query });
    case "tools-show": return requestOm({ session, route: routes.describeTool, id: command.id });
    case "tools-call": return callTool({ ...required, command });
    case "status": return requestOm({ session, route: routes.status });
    case "allowance": return requestOm({ session, route: routes.allowance });
    case "campaigns": return requestOm({ session, route: routes.campaigns, query: command.query });
    case "campaign": return showCampaign({ session, id: command.id });
    case "approvals": return listApprovals({ session, query: command.query });
    case "answer": return answerApproval({ session, runtime, ...command });
    case "halt": return halt({ session, accountId: command.accountId });
    case "ask": return ask({ command, session, runtime });
    default: { const exhaustive: never = command; return exhaustive; }
  }
}

/** Emit one JSON Outcome on stdout, or a readable terminal value/error with escaped controls. */
function printResult(required: { runtime: CliRuntime; result: Outcome<unknown>; json: boolean }): void {
  if (required.json) { required.runtime.stdout.write({ text: JSON.stringify(required.result) + "\n" }); return; }
  if (!required.result.ok) {
    required.runtime.stderr.write({ text: terminalText({ text: required.result.error.code + ": " + required.result.error.message }) + "\n" });
    return;
  }
  required.runtime.stdout.write({ text: terminalText({ text: JSON.stringify(required.result.value) }) + "\n" });
}

/** Human ask output uses observation; failed start has no run authority to cancel. */
async function runTextAsk(required: { command: Extract<Command, { name: 'ask' }>; runtime: CliRuntime; session: HttpSession }): Promise<Outcome<void>> {
  const started = await ask(required);
  if (!started.ok) { printResult({ ...required, result: started, json: false }); return started; }
  required.runtime.stdout.write({ text: '[' + (started.value.mode === 'model' ? 'Model' : 'Sandbox') + ' run ' + terminalText({ text: started.value.runId }) + ']\n' });
  const observed = await followRun({ ...required, runId: started.value.runId });
  if (!observed.ok) printResult({ ...required, result: observed, json: false });
  return observed;
}

/** Help needs no server session; other commands share one validated owner session. */
async function runParsedCommand(required: { command: Command; runtime: CliRuntime; json: boolean }): Promise<Outcome<void>> {
  if (required.command.name === "help") {
    if (required.json) printResult({ runtime: required.runtime, result: { ok: true, value: { help } }, json: true });
    else required.runtime.stdout.write({ text: help });
    return { ok: true, value: undefined };
  }
  const session = createSession({ runtime: required.runtime });
  if (!session.ok) { printResult({ runtime: required.runtime, result: session, json: required.json }); return session; }
  if (required.command.name === 'ask' && !required.json) {
    return runTextAsk({ ...required, command: required.command, session: session.value });
  }
  const result = await dispatch({ command: required.command, session: session.value, runtime: required.runtime, json: required.json });
  printResult({ runtime: required.runtime, result, json: required.json });
  if (!result.ok) return result;
  return { ok: true, value: undefined };
}

/** Execute one command using injected HTTP/file/terminal dependencies. Importing is inert.
 * @param required - argv excludes executable names; runtime is owned by the Node launcher.
 * @returns Outcome<void>; launcher maps invalid_input to exit 2, other failures to 1, success to 0.
 * Writes one JSON Outcome when --json is present; approval cards/prompts use stderr.
 * @example await runOmCli({ argv: ["status", "--json"], runtime });
 * @complexity O(input + response bytes) with fixed caps; ask observes <=300 bounded pages.
 */
export async function runOmCli(required: { argv: readonly string[]; runtime: CliRuntime }): Promise<Outcome<void>> {
  if (required.argv[0] === 'addons' || required.argv[0] === 'integrations') return runAddonCli(required);
  let json = required.argv.includes("--json") || required.argv.includes("--json=true");
  try {
    const parsed = parseCommand({ argv: required.argv });
    if (!parsed.ok) { printResult({ runtime: required.runtime, result: parsed, json }); return parsed; }
    json = parsed.value.json;
    return await runParsedCommand({ command: parsed.value.command, runtime: required.runtime, json });
  } catch {
    const result = failure<void>({ code: "unavailable", message: "CLI runtime failed; read server state before another submission" });
    printResult({ runtime: required.runtime, result, json });
    return result;
  }
}
