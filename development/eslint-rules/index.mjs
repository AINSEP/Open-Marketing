/** OM syntax rules. ESLint/SonarJS remain the metric analyzers. */
import { createSignatureAnalyzer } from './signature-types.mjs';
const signatureTypes = createSignatureAnalyzer({ root: process.cwd() });
const functions = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const controls = new Set(['IfStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement', 'SwitchStatement', 'TryStatement', 'CatchClause', 'ConditionalExpression']);
const callbackMethods = new Set(['map', 'filter', 'find', 'findIndex', 'some', 'every', 'reduce', 'sort', 'replace', 'forEach', 'flatMap', 'then', 'catch', 'on', 'once', 'addEventListener', 'refine', 'superRefine', 'forEachChild']);
const callbackFunctions = new Set(['it', 'test', 'describe', 'expect', 'useEffect', 'useMemo', 'useCallback', 'useState']);
/** Only immediate callback positions of documented foreign APIs retain their ABI. */
function foreignCallback({ node, source }) {
  if (compilerHostCallback({ node })) return true;
  const call = node.parent;
  if (call?.type !== 'CallExpression' || !Array.from(call.arguments).some(argument => argument.range?.[0] === node.range?.[0])) return false;
  const callee = call.callee;
  if (callee.type === 'Identifier') return callbackFunctions.has(callee.name) || reactUpdater({ name: callee.name, node, source });
  if (callee.type === 'CallExpression') return callee.callee.type === 'MemberExpression' && callee.callee.property.name === 'each';
  if (callee.type !== 'MemberExpression') return false;
  return (callee.object.name === 'Array' && callee.property.name === 'from') || callbackMethods.has(callee.property.name) || ['it', 'test', 'describe'].includes(callee.object?.callee?.name);
}
/** TypeScript compiler-host adapter has the upstream positional ABI (fixture-tested). */
function compilerHostCallback({ node }) {
 const parent = node.parent;
 return parent?.type === 'AssignmentExpression' && parent.left.type === 'MemberExpression' && parent.left.object.name === 'host' && parent.left.property.name === 'getSourceFile';
}
/** React updater callbacks are identified from their actual useState binding. */
function reactUpdater({ name, node, source }) {
 let scope = source.getScope(node);
 while (scope) {
  const variable = Array.from(scope.variables).find(item => item.name === name);
  if (variable) return Array.from(variable.defs).some(def => def.node.init?.callee?.name === 'useState' && def.node.id.type === 'ArrayPattern' && def.node.id.elements[1]?.name === name);
  scope = scope.upper;
 }
 return false;
}
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
  if (foreignCallback({ node, source: context.sourceCode }) && context.semantic.foreignCallback({ node })) return;
  if (node.params.length > 2 || Array.from(node.params).some(parameter => !objectParameter({ parameter, source: context.sourceCode, semantic: context.semantic }))) context.report({ node, message: 'Owned signatures accept at most two object arguments; wrap foreign ABIs at their callback boundary.' });
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
