/** Node wire effects under the existing federation protocol adapters; imports are inert. */
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AddonFederationEffects } from './addon-federation.js';

/** Bind fetch and the installed SDK process transport once at the executable root.
 * SDK owns stdio framing/buffer bounds; federation owns MCP validation, timeouts and fences.
 * @example createNodeFederationEffects({ fetch, stdio: input => new StdioClientTransport(input) });
 * @returns Lazy HTTP/stdio effects; factory never opens a socket/process.
 * @complexity HTTP <=256 KiB per response; stdio <=256 KiB per frame, no retained transcript.
 */
export function createNodeFederationEffects(required: { fetch: typeof fetch; stdio: (input: StdioServerParameters) => Transport }): AddonFederationEffects {
  return {
    exchange: { async send(input, options) {
      const response = await required.fetch(input.url, { method: input.method, headers: input.headers,
        body: options?.body, signal: options?.signal, redirect: 'error' });
      return { status: response.status, contentType: response.headers.get('content-type') ?? '',
        sessionId: response.headers.get('mcp-session-id') ?? undefined,
        wwwAuthenticate: response.headers.get('www-authenticate') ?? undefined, text: await readResponse({ response }) };
    } },
    openStdio: input => openStdio({ ...input, stdio: required.stdio }),
  };
}

/** Bound streamed HTTP bytes before decoding; close the body even on oversize/invalid UTF-8. */
async function readResponse(required: { response: Response }): Promise<string> {
  const reader = required.response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0; let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      size += chunk.value.byteLength;
      if (size > 262144) throw new RangeError('MCP response byte cap');
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}

/** Adapt the installed SDK's async transport to Jini's narrow channel ABI. No shell or stderr log.
 * Abort closes the child; opaque SDK errors become fixed close reasons, never credential output.
 */
async function openStdio(required: Parameters<AddonFederationEffects['openStdio']>[0] & {
  stdio: (input: StdioServerParameters) => Transport;
}): ReturnType<AddonFederationEffects['openStdio']> {
  required.signal?.throwIfAborted();
  const transport = required.stdio({ command: required.server.command, args: [...required.server.args ?? []],
    env: { ...required.server.env }, cwd: required.server.cwd, stderr: 'ignore', maxBufferSize: 262144 });
  let receive: (input: { message: string }) => void = () => undefined;
  let closed: (input: { reason: string }) => void = () => undefined;
  const close = (): void => { void transport.close().catch(() => closed({ reason: 'MCP channel close failed' })); };
  transport.onmessage = message => receive({ message: JSON.stringify(message) });
  transport.onclose = () => { required.signal?.removeEventListener('abort', close); closed({ reason: 'MCP channel closed' }); };
  transport.onerror = () => { closed({ reason: 'MCP channel failed' }); close(); };
  required.signal?.addEventListener('abort', close, { once: true });
  try { await transport.start(); required.signal?.throwIfAborted(); }
  catch { required.signal?.removeEventListener('abort', close); close(); throw new Error('MCP process unavailable'); }
  return {
    send({ message }) { void transport.send(JSONRPCMessageSchema.parse(JSON.parse(message))).catch(() => { closed({ reason: 'MCP send failed' }); close(); }); },
    onMessage({ listener }) { receive = listener; }, onClose({ listener }) { closed = listener; }, close,
  };
}
