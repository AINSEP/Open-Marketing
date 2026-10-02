import { createInterface } from 'node:readline';
/** Standalone local MCP fixture; readline's foreign string callback is immediately wrapped. */
const reader = createInterface({ input: process.stdin });
reader.on('line', line => handleLine({ line }));

function handleLine({ line }) {
  if (line.length > 100000) { process.exitCode = 1; reader.close(); return; }
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const reply = createReply({ request });
  process.stdout.write(JSON.stringify(reply) + '\n');
}
function createReply({ request }) {
  if (request.method === 'initialize') return { jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'federation-stdio-fixture', version: '1.0.0' } } };
  const args = request.params?.arguments ?? {};
  if (args.query === 'unknown') return { jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'fixture uncertainty' } };
  return { jsonrpc: '2.0', id: request.id, result: toolResult({ arguments: args, metadata: request.params?._meta }) };
}
function toolResult(required) {
  switch (required.arguments.query) {
    case 'oversized': return { content: [{ type: 'text', text: 'x'.repeat(262145) }] };
    case 'invalid': return { content: [{ type: 'resource_link', uri: 'file:///secret', name: 'secret' }] };
    case 'tainted': return { content: [{ type: 'text', text: 42 }] };
    default: return { content: [{ type: 'text', text: JSON.stringify(required) }], structuredContent: { echo: required.arguments.query }, _meta: { vendorSecret: 'must be stripped', vendorConfiguration: 'must be stripped' } };
  }
}
