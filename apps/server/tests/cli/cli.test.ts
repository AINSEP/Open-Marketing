/** Fixture-only CLI contracts: no server, filesystem, credentials, or vendor effects. */
import { describe, expect, it } from "vitest";
import type { ConfirmationCard } from "@open-marketing/contracts";
import { runOmCli } from "../../src/cli/index.js";
import type { CliRuntime } from "../../src/cli/index.js";

const card: ConfirmationCard = {
  cardId: "card-7", operationId: "operation-9", argumentsDigest: "a".repeat(64),
  arguments: { accountId: "account-3", amount: 1700, currency: "USD" },
  allowedChoices: ["allow", "cancel"], expiresAt: 2000, classification: "spend",
};
const campaign = { id: "campaign-3", title: "Autumn", detail: "Paused draft", status: "paused" };
const allowance = {
  daily: { minorUnits: 1000, currency: "USD" }, remaining: { minorUnits: 730, currency: "USD" }, timezone: "America/Los_Angeles",
};

/** Serialize the wire envelope independently of production schemas and route tables. */
function wire(required: { input: unknown; status?: number }): Response {
  return new Response(JSON.stringify(required.input), { status: required.status ?? 200 });
}
function success(required: { value: unknown }): Response {
  return wire({ input: { ok: true, value: required.value } });
}

/** Deterministic native-fetch wrapper; an unexpected request fails rather than returning canned data.
 * Real CLI parsing, transport, validation, rendering, and confirmation all run through index.ts.
 */
function fixture(required: { responses: readonly (Response | Error)[] }) {
  const responses = [...required.responses];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const events: string[] = [];
  const files: string[] = [];
  const deadlines: { timeoutMs: number; disposed: boolean; signal: AbortSignal }[] = [];
  const requests: {
    url: string; method: string | undefined; body: unknown; headers: Headers;
    redirect: RequestRedirect | undefined; signal: AbortSignal | null | undefined;
  }[] = [];
  const settings: {
    now: number; confirmed: boolean; afterConfirm?: number; promptError?: boolean;
    confirmError?: boolean; chunks: Uint8Array[];
  } = { now: 1000, confirmed: false, chunks: [] };
  let nextId = 0;
  const runtime: CliRuntime = {
    env: { OM_SERVER_URL: "http://om.fixture", OM_OWNER_TOKEN: "owner-fixture-token" },
    // The CLI supplies URL objects; keep this fixture wrapper narrower than native fetch.
    fetch: (async (input: URL, init?: RequestInit) => {
      if (!(input instanceof URL)) throw new Error("Fixture requires a URL object");
      events.push("fetch");
      requests.push({
        url: String(input), method: init?.method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        headers: new Headers(init?.headers), redirect: init?.redirect, signal: init?.signal,
      });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected fixture request");
      if (response instanceof Error) throw response;
      return response;
    }) as CliRuntime["fetch"],
    stdout: { write({ text }) { stdout.push(text); } },
    stderr: { write({ text }) { events.push("display"); stderr.push(text); } },
    clock: { now() { return settings.now; } },
    ids: { next() { return nextId++ === 0 ? "correlation-7" : "trace-9"; } },
    deadline: { create({ timeoutMs }) {
      const controller = new AbortController();
      const deadline = { timeoutMs, disposed: false, signal: controller.signal };
      deadlines.push(deadline);
      return { signal: deadline.signal, dispose() { deadline.disposed = true; } };
    } },
    async *readPrompt({ path, signal }) {
      files.push(path);
      signal.throwIfAborted();
      if (settings.promptError) throw new Error("Fixture read failed");
      yield* settings.chunks;
    },
    async confirm() {
      events.push("confirm");
      if (settings.confirmError) throw new Error("Fixture terminal failed");
      settings.now = settings.afterConfirm ?? settings.now;
      return settings.confirmed;
    },
  };
  return { runtime, requests, stdout, stderr, events, files, deadlines, settings };
}

describe("command HTTP and output contracts", () => {
  it.each([
    { argv: ["status"], path: "/api/status", value: { ready: true, mode: "production" }, method: "GET", body: undefined },
    { argv: ["campaigns", "list"], path: "/api/campaigns?limit=25", value: { items: [campaign], cursor: "next-3" }, method: "GET", body: undefined },
    { argv: ["campaigns", "show", "campaign-3"], path: "/api/campaigns/campaign-3", value: campaign, method: "GET", body: undefined },
    { argv: ["approvals", "list"], path: "/api/safety/approvals?limit=25", value: { items: [card], cursor: null }, method: "GET", body: undefined },
    { argv: ["ads", "halt", "--account", "account-3"], path: "/api/safety/halt", value: { accountId: "account-3", status: "pending" }, method: "POST", body: { accountId: "account-3" } },
    { argv: ["settings", "generation", "show"], path: "/api/safety/allowance", value: allowance, method: "GET", body: undefined },
    { argv: ["ask", "Plan an autumn campaign"], path: "/api/runs", value: { runId: "run-8", status: "requested" }, method: "POST", body: { prompt: "Plan an autumn campaign" } },
  ])("uses the proposed endpoint for $argv", async ({ argv, path, value, method, body }) => {
    const f = fixture({ responses: [success({ value })] });
    expect(await runOmCli({ argv: [...argv, "--json"], runtime: f.runtime })).toEqual({ ok: true, value: undefined });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]).toMatchObject({ url: "http://om.fixture" + path, method, body, redirect: "error" });
    const headers: Record<string, string> = {};
    f.requests[0].headers.forEach((value, key) => { headers[key] = value; });
    expect(headers).toEqual({
      accept: "application/json", authorization: "Bearer owner-fixture-token", "content-type": "application/json",
      "x-correlation-id": "correlation-7", "x-trace-id": "trace-9", "idempotency-key": "correlation-7",
    });
    expect(f.requests[0].signal).toBe(f.deadlines[0].signal);
    expect(f.deadlines.map(({ timeoutMs, disposed }) => ({ timeoutMs, disposed }))).toEqual([{ timeoutMs: 15000, disposed: true }]);
    expect(f.stdout).toEqual([JSON.stringify({ ok: true, value }) + "\n"]);
    expect(f.stderr).toEqual([]);
  });

  it.each(["campaigns", "approvals"])("requests exactly one bounded %s page with an encoded cursor", async root => {
    const f = fixture({ responses: [success({ value: { items: [], cursor: "another-page" } })] });
    expect((await runOmCli({ argv: [root, "list", "--limit", "100", "--cursor", "page /?"], runtime: f.runtime })).ok).toBe(true);
    const prefix = root === "campaigns" ? "/api/campaigns" : "/api/safety/approvals";
    expect(f.requests.map(({ url }) => url)).toEqual(["http://om.fixture" + prefix + "?limit=100&cursor=page+%2F%3F"]);
  });

  it("emits one JSON result for help and invalid input", async () => {
    const helpFixture = fixture({ responses: [] });
    await runOmCli({ argv: ["--help", "--json"], runtime: helpFixture.runtime });
    expect(helpFixture.stdout).toHaveLength(1);
    expect(JSON.parse(helpFixture.stdout[0])).toMatchObject({ ok: true, value: { help: expect.stringContaining("om ask") } });
    const invalidFixture = fixture({ responses: [] });
    await runOmCli({ argv: ["status", "--unknown", "--json"], runtime: invalidFixture.runtime });
    expect(invalidFixture.stdout).toHaveLength(1);
    expect(JSON.parse(invalidFixture.stdout[0])).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(invalidFixture.stderr).toEqual([]);
  });

  it("encodes a campaign identifier as one path segment", async () => {
    const value = { ...campaign, id: "campaign/one?" };
    const f = fixture({ responses: [success({ value })] });
    expect((await runOmCli({ argv: ["campaigns", "show", value.id], runtime: f.runtime })).ok).toBe(true);
    expect(f.requests[0].url).toBe("http://om.fixture/api/campaigns/campaign%2Fone%3F");
  });

  it.each(["requested", "pending", "completed", "failed"] as const)("preserves a %s halt receipt", async status => {
    const value = status === "failed"
      ? { accountId: "account-3", status, error: { code: "unavailable", message: "Remote stop failed", retryable: false } }
      : { accountId: "account-3", status };
    const f = fixture({ responses: [success({ value })] });
    await runOmCli({ argv: ["ads", "halt", "--account", "account-3", "--json"], runtime: f.runtime });
    expect(f.stdout).toEqual([JSON.stringify({ ok: true, value }) + "\n"]);
  });

  it("rejects campaign and halt receipts for a different identifier", async () => {
    for (const test of [
      { argv: ["campaigns", "show", "campaign-3"], value: { ...campaign, id: "other" } },
      { argv: ["ads", "halt", "--account", "account-3"], value: { accountId: "other", status: "completed" } },
    ]) {
      const f = fixture({ responses: [success({ value: test.value })] });
      expect(await runOmCli({ argv: test.argv, runtime: f.runtime })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    }
  });

  it("renders help without authentication, file reads, or HTTP", async () => {
    for (const argv of [[], ["--help"], ["ask", "--help"], ["approvals", "answer", "--help"], ["campaigns", "show", "--help"]]) {
      const f = fixture({ responses: [] });
      expect((await runOmCli({ argv, runtime: { ...f.runtime, env: {} } })).ok).toBe(true);
      expect(f.stdout.join("")).toContain("om ask");
      expect(f.requests).toEqual([]);
      expect(f.files).toEqual([]);
    }
  });
});

describe("strict CLI and prompt boundaries", () => {
  it.each([
    ["unknown"], ["status", "extra"], ["campaigns", "show"], ["campaigns", "show", ".."],
    ["status", "--limit", "3"], ["status", "--unknown"], ["status", "--json", "--json"],
    ["campaigns", "list", "--limit", "0"], ["campaigns", "list", "--limit", "101"],
    ["campaigns", "list", "--limit", "1.5"], ["campaigns", "list", "--limit", "1e2"],
    ["approvals", "answer", "card-7"], ["approvals", "answer", "card-7", "--choice", "yes"],
    ["approvals", "answer", "card-7", "--choice", "allow", "--confirm-digest", "bad"],
    ["approvals", "answer", "card-7", "--choice", "allow", "--prompt-file", "-"],
    ["ads", "halt"], ["ask"], ["ask", "one", "two"], ["ask", "text", "--prompt-file", "-"],
    ["ask", "--prompt-file", ""], ["ask", "  "],
  ])("rejects invalid arguments %j", async (...argv) => {
    const f = fixture({ responses: [] });
    expect(await runOmCli({ argv, runtime: f.runtime })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.requests).toEqual([]);
    expect(f.files).toEqual([]);
  });

  it.each(["prompt.txt", "-"])("reads a plain UTF-8 prompt from %s, preserving split characters", async path => {
    const f = fixture({ responses: [success({ value: { runId: "run-8", status: "pending", expiresAt: 3000 } })] });
    const bytes = new TextEncoder().encode("café\n");
    f.settings.chunks = [bytes.slice(0, 4), bytes.slice(4)];
    expect((await runOmCli({ argv: ["ask", "--prompt-file", path, "--json"], runtime: f.runtime })).ok).toBe(true);
    expect(f.files).toEqual([path]);
    expect(f.requests[0]).toMatchObject({ url: "http://om.fixture/api/runs", method: "POST", body: { prompt: "café\n" } });
    expect(f.stdout).toEqual(['{"ok":true,"value":{"runId":"run-8","status":"pending","expiresAt":3000}}\n']);
    expect(f.deadlines.every(({ disposed }) => disposed)).toBe(true);
  });

  it("accepts exactly 64 KiB from a file, rejecting overflow without POST", async () => {
    for (const size of [65536, 65537]) {
      const f = fixture({ responses: [success({ value: { runId: "run-8", status: "requested" } })] });
      f.settings.chunks = [new TextEncoder().encode("x".repeat(65536)), new TextEncoder().encode("x".repeat(size - 65536))];
      const result = await runOmCli({ argv: ["ask", "--prompt-file", "-", "--json"], runtime: f.runtime });
      if (size === 65536) {
        expect(result.ok).toBe(true);
        expect(f.requests[0].body).toEqual({ prompt: "x".repeat(65536) });
      } else {
        expect(result).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
        expect(f.requests).toEqual([]);
      }
      expect(f.deadlines.every(({ disposed }) => disposed)).toBe(true);
    }
  });

  it.each(["empty", "malformed UTF-8", "read failure"])("rejects %s prompt input", async kind => {
    const f = fixture({ responses: [] });
    f.settings.chunks = kind === "malformed UTF-8" ? [new Uint8Array([255])] : [];
    f.settings.promptError = kind === "read failure";
    expect(await runOmCli({ argv: ["ask", "--prompt-file", "-"], runtime: f.runtime })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.requests).toEqual([]);
    expect(f.deadlines[0].disposed).toBe(true);
  });

  it("bounds argument count and byte length before I/O", async () => {
    for (const argv of [Array<string>(65).fill("status"), ["ask", "é".repeat(32769)]]) {
      const f = fixture({ responses: [] });
      expect(await runOmCli({ argv, runtime: f.runtime })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
      expect(f.requests).toEqual([]);
    }
  });
});

describe("exact approval exchange", () => {
  const argv = ["approvals", "answer", "card-7", "--choice", "allow", "--json"];

  it("displays before interactive confirmation and submits only the exact answer", async () => {
    const f = fixture({ responses: [success({ value: card }), success({ value: { status: "recorded" } })] });
    f.settings.confirmed = true;
    expect((await runOmCli({ argv, runtime: f.runtime })).ok).toBe(true);
    expect(f.events).toEqual(["fetch", "display", "confirm", "fetch"]);
    expect(f.stderr).toEqual(["Approval card: " + JSON.stringify(card) + "\nChoice: allow\n"]);
    expect(f.requests[1]).toMatchObject({
      url: "http://om.fixture/api/safety/approvals/card-7/answer", method: "POST",
      body: { cardId: "card-7", operationId: "operation-9", argumentsDigest: "a".repeat(64), choice: "allow" },
    });
    expect(f.stdout).toEqual(['{"ok":true,"value":{"status":"recorded"}}\n']);
    expect(f.requests[1].headers.get("x-trace-id")).toBe(f.requests[0].headers.get("x-trace-id"));
  });

  it("requires explicit confirmation even with --json", async () => {
    const f = fixture({ responses: [success({ value: card })] });
    expect(await runOmCli({ argv, runtime: f.runtime })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(f.stderr.join("")).toContain(JSON.stringify(card));
    expect(f.requests).toHaveLength(1);
    expect(f.stdout).toHaveLength(1);
  });

  it.each(["a", "b"])("requires a matching noninteractive digest (%s)", async digit => {
    const f = fixture({ responses: [success({ value: card }), success({ value: { status: "recorded" } })] });
    const result = await runOmCli({ argv: [...argv, "--confirm-digest", digit.repeat(64)], runtime: f.runtime });
    expect(f.events).not.toContain("confirm");
    expect(f.stderr.join("")).toContain(JSON.stringify(card));
    if (digit === "a") {
      expect(result.ok).toBe(true);
      expect(f.requests).toHaveLength(2);
    } else {
      expect(result).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(f.requests).toHaveLength(1);
    }
  });

  it.each([
    { value: { ...card, cardId: "other" }, code: "conflict" },
    { value: { ...card, expiresAt: 1000 }, code: "expired" },
    { value: { ...card, allowedChoices: ["cancel"] }, code: "forbidden" },
    { value: { ...card, argumentsDigest: "bad" }, code: "protocol_mismatch" },
    { value: { ...card, arguments: { password: "hidden" } }, code: "forbidden" },
    { value: { ...card, arguments: { note: "Bearer sensitive" } }, code: "forbidden" },
    { value: { ...card, allowedChoices: ["allow", "always_allow"] }, code: "forbidden" },
    { value: { ...card, classification: "destructive", allowedChoices: ["allow_chat"] }, code: "forbidden" },
    { value: { ...card, arguments: { text: "é".repeat(17000) } }, code: "limit_exceeded" },
  ])("rejects an invalid card ($code) before display or answer", async ({ value, code }) => {
    const f = fixture({ responses: [success({ value })] });
    expect(await runOmCli({ argv, runtime: f.runtime })).toMatchObject({ ok: false, error: { code } });
    expect(f.requests).toHaveLength(1);
    expect(f.stderr).toEqual([]);
    expect(f.events).toEqual(["fetch"]);
  });

  it("rechecks expiry after terminal confirmation", async () => {
    const f = fixture({ responses: [success({ value: card })] });
    f.settings.confirmed = true;
    f.settings.afterConfirm = 2000;
    expect(await runOmCli({ argv, runtime: f.runtime })).toMatchObject({ ok: false, error: { code: "expired" } });
    expect(f.events).toEqual(["fetch", "display", "confirm"]);
  });

  it("rejects an execution claim in an approval acknowledgement without resubmitting", async () => {
    const f = fixture({ responses: [success({ value: card }), success({ value: { status: "executed" } })] });
    expect(await runOmCli({ argv: [...argv, "--confirm-digest", "a".repeat(64)], runtime: f.runtime }))
      .toMatchObject({ ok: false, error: { code: "protocol_mismatch", retryable: false } });
    expect(f.requests.filter(({ method }) => method === "POST")).toHaveLength(1);
    expect(JSON.parse(f.stdout[0]).error.message).toContain("outcome unknown");
  });

  it("fails closed if the clock or confirmation callback fails", async () => {
    for (const kind of ["clock", "terminal"]) {
      const f = fixture({ responses: [success({ value: card })] });
      f.settings.now = kind === "clock" ? NaN : 1000;
      f.settings.confirmError = kind === "terminal";
      expect(await runOmCli({ argv, runtime: f.runtime })).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(f.requests).toHaveLength(1);
    }
  });

  it("allows a server-offered generation grant without classifying it locally", async () => {
    const f = fixture({ responses: [
      success({ value: { ...card, classification: "generation", allowedChoices: ["always_allow", "cancel"] } }),
      success({ value: { status: "recorded" } }),
    ] });
    f.settings.confirmed = true;
    expect((await runOmCli({ argv: ["approvals", "answer", "card-7", "--choice", "always_allow"], runtime: f.runtime })).ok).toBe(true);
    expect(f.requests[1].body).toEqual({ cardId: "card-7", operationId: "operation-9", argumentsDigest: "a".repeat(64), choice: "always_allow" });
  });

  it("rejects a mixed unsafe approval page without displaying partial cards", async () => {
    const f = fixture({ responses: [success({ value: { items: [card, { ...card, arguments: { apiKey: "hidden" } }], cursor: null } })] });
    expect(await runOmCli({ argv: ["approvals", "list", "--json"], runtime: f.runtime })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.stdout.join("")).not.toContain("operation-9");
  });

  it("escapes terminal control characters while retaining the exact digest and arguments", async () => {
    const value = { ...card, arguments: { note: "title\u001b[31m\u202e" } };
    const f = fixture({ responses: [success({ value }), success({ value: { status: "recorded" } })] });
    f.settings.confirmed = true;
    expect((await runOmCli({ argv, runtime: f.runtime })).ok).toBe(true);
    expect(f.stderr.join("")).not.toContain("\u001b");
    expect(f.stderr.join("")).not.toContain("\u202e");
    expect(f.stderr.join("")).toContain("\\u202e");
    expect(f.requests[1].body).toEqual({ cardId: "card-7", operationId: "operation-9", argumentsDigest: "a".repeat(64), choice: "allow" });
  });
});

describe("transport failures and configuration", () => {
  it.each([
    { status: 401, code: "unauthenticated" }, { status: 403, code: "forbidden" },
    { status: 501, code: "not_implemented" }, { status: 503, code: "unavailable" },
  ])("reports the server's $code error honestly", async ({ status, code }) => {
    const error = { code, message: "Fixture owner route unavailable", retryable: false };
    const f = fixture({ responses: [wire({ input: { ok: false, error }, status })] });
    expect(await runOmCli({ argv: ["status", "--json"], runtime: f.runtime })).toEqual({ ok: false, error });
    expect(f.stdout).toEqual([JSON.stringify({ ok: false, error }) + "\n"]);
    expect(f.stderr).toEqual([]);
  });

  it.each(["malformed JSON", "wrong DTO", "wrong envelope", "contradictory status", "redirect", "empty body"])("rejects %s", async kind => {
    const response = {
      "malformed JSON": new Response("{"),
      "wrong DTO": success({ value: { ready: "yes", mode: "production" } }),
      "wrong envelope": wire({ input: { ready: true, mode: "production" } }),
      "contradictory status": wire({ input: { ok: true, value: { ready: true, mode: "production" } }, status: 500 }),
      redirect: new Response(null, { status: 302 }),
      "empty body": new Response(null),
    }[kind]!;
    const f = fixture({ responses: [response] });
    expect(await runOmCli({ argv: ["status"], runtime: f.runtime })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(f.requests).toHaveLength(1);
    expect(f.deadlines[0].disposed).toBe(true);
  });

  it("rejects oversized streamed HTTP data", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(1048576));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    } });
    const f = fixture({ responses: [new Response(stream)] });
    expect(await runOmCli({ argv: ["status"], runtime: f.runtime })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    expect(f.deadlines[0].disposed).toBe(true);
  });

  it("accepts a valid response at exactly the 1 MiB boundary", async () => {
    const text = '{"ok":true,"value":{"ready":true,"mode":"production"}}';
    const f = fixture({ responses: [new Response(text + " ".repeat(1048576 - text.length))] });
    expect((await runOmCli({ argv: ["status"], runtime: f.runtime })).ok).toBe(true);
    expect(f.stdout).toEqual(['{"ready":true,"mode":"production"}\n']);
  });

  it.each([
    ["ads", "halt", "--account", "account-3"], ["ask", "Plan a campaign"],
    ["approvals", "answer", "card-7", "--choice", "allow", "--confirm-digest", "a".repeat(64)],
  ])("never retries after POST response loss: %j", async (...argv) => {
    const responses = argv[0] === "approvals" ? [success({ value: card }), new Error("response lost")] : [new Error("response lost")];
    const f = fixture({ responses });
    const result = await runOmCli({ argv, runtime: f.runtime });
    expect(result).toMatchObject({ ok: false, error: { code: "unavailable", retryable: false } });
    expect(f.stderr.join("")).toContain("outcome unknown");
    expect(f.requests.filter(({ method }) => method === "POST")).toHaveLength(1);
    expect(f.deadlines.every(({ disposed }) => disposed)).toBe(true);
  });

  it("reports a failed GET as unavailable and never automatically retries", async () => {
    const f = fixture({ responses: [new Error("timeout")] });
    expect(await runOmCli({ argv: ["status"], runtime: f.runtime })).toMatchObject({ ok: false, error: { code: "unavailable", retryable: true } });
    expect(f.requests).toHaveLength(1);
    expect(f.stdout).toEqual([]);
  });

  it.each([
    { OM_SERVER_URL: "http://om.fixture" }, { OM_SERVER_URL: "file:///tmp/om", OM_OWNER_TOKEN: "owner" },
    { OM_SERVER_URL: "https://owner:secret@om.fixture", OM_OWNER_TOKEN: "owner" },
    { OM_SERVER_URL: "https://om.fixture/api", OM_OWNER_TOKEN: "owner" },
    { OM_SERVER_URL: "https://om.fixture/?key=x", OM_OWNER_TOKEN: "owner" },
    { OM_SERVER_URL: "https://om.fixture", OM_OWNER_TOKEN: "owner\r\ninjected" },
    { OM_SERVER_URL: "http://om.fixture", OM_AGENT_TOKEN: "agent-only" },
  ])("rejects invalid owner configuration before HTTP: %j", async env => {
    const f = fixture({ responses: [] });
    expect((await runOmCli({ argv: ["status", "--json"], runtime: { ...f.runtime, env } })).ok).toBe(false);
    expect(f.requests).toEqual([]);
    expect(f.stdout).toHaveLength(1);
    expect(f.stdout.join("")).not.toContain("injected");
    expect(f.stdout.join("")).not.toContain("agent-only");
  });
});

it('prints authoritative estimated usage after a completed ask', async () => {
 const usage = { kind: 'usage', inputTokens: 10, outputTokens: 5, durationMs: 8000, costUsd: .07, totalCostUsd: .58, complete: true, costBasis: 'estimated' };
 const event = { protocolVersion: 1, eventId: 'done', runId: 'run-8', sequence: 1, correlationId: 'correlation-7', traceId: 'trace-9', kind: 'ended', payload: {} };
 const f = fixture({ responses: [success({ value: { runId: 'run-8', status: 'pending' } }), success({ value: { runId: 'run-8', status: 'completed', events: [event], usage } })] });
 expect((await runOmCli({ argv: ['ask', 'fixture'], runtime: f.runtime })).ok).toBe(true);
 expect(f.stdout.join('')).toContain('[Usage estimate] ' + JSON.stringify(usage));
});
