/** OM syntax rules. ESLint/SonarJS remain the metric analyzers. */
import { createSignatureAnalyzer } from './signature-types.mjs';
const signatureTypes = createSignatureAnalyzer({ root: process.cwd() });
const functions = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const controls = new Set(['IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement', 'SwitchStatement', 'TryStatement', 'CatchClause', 'ConditionalExpression']);
/** A destructured object or structural object annotation is an owned argument object. */
function objectParameter({ parameter, source, semantic }) {
  const node = parameter.type === 'AssignmentPattern' ? parameter.left : parameter;
  const type = node.typeAnnotation?.typeAnnotation;
  if (node.type === 'ObjectPattern' && !type) return true;
  if (type?.type === 'TSTypeLiteral' && !Array.from(type.members).some(member => ['TSCallSignatureDeclaration','TSConstructSignatureDeclaration'].includes(member.type))) return true;
  return semantic.objectParameter({ parameter });
}
/** ESLint's listener ABI is one node argument; the owned implementation uses an object. */
function checkSignature({ node, context }) {
  if (node.params.length === 0) return;
  if (node.params.length <= 2 && Array.from(node.params).every(parameter => objectParameter({ parameter, source: context.sourceCode, semantic: context.semantic }))) return;
  if (context.semantic.foreignCallback({ node })) return;
  context.report({ node, message: 'Owned signatures accept at most two object arguments; wrap foreign ABIs at their callback boundary.' });
}
const signatureRule = {
  meta: { type: 'problem', schema: [] },
  create({ sourceCode, report, filename }) {
    const context = { sourceCode, report, filename, semantic: signatureTypes.forSource({ filename, source: sourceCode.text }) };
    function checkType({ node }) { checkSignature({ node: { ...node, params: node.params ?? node.parameters ?? [] }, context }); }
    return { ':function'({ ...node }) { checkSignature({ node, context }); }, TSMethodSignature({ ...node }) { checkType({ node }); }, TSFunctionType({ ...node }) { checkType({ node }); } };
  },
};
/** Count control structures including ternaries, try/catch and else-if (flattened). */
export function nestingDepth({ node }) {
  let depth = 1;
  let current = node;
  while (current.parent && !functions.has(current.parent.type)) {
    const parent = current.parent;
    if (controls.has(parent.type) && !(parent.type === 'IfStatement' && parent.alternate === current)) depth++;
    current = parent;
  }
  return depth;
}
const nestingRule = {
  meta: { type: 'problem', schema: [] },
  create({ sourceCode, report, filename }) {
    const context = { sourceCode, report, filename };
    return Object.fromEntries([...controls].map(type => [type, ({ ...node }) => {
      if (nestingDepth({ node }) > 3) context.report({ node, message: 'OM control nesting exceeds 3.' });
    }]));
  },
};
/** In TSX every enclosing render function is checked, including JSX/effect callbacks. */
function checkComponent({ node, context }) {
  if (!/\.[tj]sx$/.test(context.filename)) return;
  let parent = node.parent;
  while (parent) {
    if (functions.has(parent.type)) { context.report({ node, message: 'No function definitions inside TSX component bodies; extract to hooks/rules.' }); return; }
    parent = parent.parent;
  }
}
export default { rules: {
  'two-object-arguments': signatureRule,
  'control-depth': nestingRule,
  'no-functions-in-component-body': { meta: { type: 'problem', schema: [] }, create({ sourceCode, report, filename }) {
    const context = { sourceCode, report, filename }; return { ':function'({ ...node }) { checkComponent({ node, context }); } }; } },
} };
