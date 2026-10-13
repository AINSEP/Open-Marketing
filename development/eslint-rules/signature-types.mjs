import ts from 'typescript';
import { resolve } from 'node:path';
import { sourceFiles } from '../scripts/workspace.mjs';
/** One analyzer instance per ESLint configuration; no application runtime state. */
export function createSignatureAnalyzer({ root }) {
 let workspace;
 function programFor({ filename, source }) {
  workspace ??= ts.createProgram(sourceFiles({ root }).map(file => resolve(root, file)), options());
  const file = resolve(filename);
  const existing = workspace.getSourceFile(file);
  if (existing?.text === source) return { program: workspace, file: existing };
  const host = ts.createCompilerHost(options());
  const original = host.getSourceFile;
  host.getSourceFile = (name, languageVersion, onError, create) => resolve(name) === file ? ts.createSourceFile(file, source, languageVersion, true) : original(name, languageVersion, onError, create);
  const program = ts.createProgram([file], options(), host);
  return { program, file: program.getSourceFile(file) };
 }
 return { forSource({ filename, source }) {
  let analysis;
  return { foreignCallback({ node }) {
   if (!['FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return false;
   analysis ??= programFor({ filename, source });
   const parameter = parameterAt({ source: analysis.file, start: node.params[0].range[0] });
   if (!parameter) return false;
   return upstreamImplementation({ analysis, implementation: parameter.parent });
  }, objectParameter({ parameter }) {
   analysis ??= programFor({ filename, source });
   const node = parameter.type === 'AssignmentPattern' ? parameter.left : parameter;
   const candidate = parameterAt({ source: analysis.file, start: node.range[0] });
   if (!candidate) return false;
   return structuralObject({ type: analysis.program.getTypeChecker().getTypeAtLocation(candidate), checker: analysis.program.getTypeChecker() });
  } };
 } };
}
/** Only a contextual callable declared upstream retains its positional ABI.
 * Owned aliases and lookalike methods cannot borrow an upstream registration name.
 * @complexity O(s) signatures; declaration provenance is checked without executing code.
 */
function upstreamImplementation({ analysis, implementation }) {
 const checker = analysis.program.getTypeChecker();
 let contextual = checker.getContextualType(implementation);
 if (ts.isMethodDeclaration(implementation)) {
  const owner = checker.getContextualType(implementation.parent);
  const property = owner && checker.getPropertyOfType(owner, implementation.name.text);
  contextual = property && checker.getTypeOfSymbolAtLocation(property, implementation);
 }
 return Boolean(contextual && upstreamCallable({ type: contextual }));
}
/** @param {{ type: import('typescript').Type }} required */
function upstreamCallable({ type }) {
 if (type.isUnion()) {
  const callables = type.types.filter(item => item.getCallSignatures().length > 0);
  return callables.length > 0 && callables.every(item => upstreamCallable({ type: item }));
 }
 // Generic upstream wrappers (for example a spy) retain the wrapped function's ownership.
 const callableArguments = (type.aliasTypeArguments ?? []).filter(argument => argument.getCallSignatures().length > 0);
 if (!callableArguments.every(argument => upstreamCallable({ type: argument }))) return false;
 const signatures = type.getCallSignatures();
 return signatures.length > 0 && signatures.every(signature => foreignDeclaration({ declaration: signature.declaration }));
}
function foreignDeclaration({ declaration }) {
 return Boolean(declaration && /\/node_modules\//.test(declaration.getSourceFile().fileName));
}
/** Contextual method parameters and imported/indexed aliases are resolved by TypeScript. */
function parameterAt({ source, start }) {
 let found;
 function visit({ node }) {
  if (ts.isParameter(node) && node.getStart(source) === start) found = node;
  if (!found) ts.forEachChild(node, child => visit({ node: child }));
 }
 if (source) visit({ node: source });
 return found;
}
function structuralObject({ type, checker }) {
 if (type.isUnion()) return Array.from(type.types).filter(item => !(item.flags & ts.TypeFlags.Undefined)).every(item => structuralObject({ type: item, checker }));
 if (type.isIntersection()) return Array.from(type.types).every(item => structuralObject({ type: item, checker }));
 if (type.flags & ts.TypeFlags.TypeParameter) {
  const constraint = checker.getBaseConstraintOfType(type);
  return Boolean(constraint && structuralObject({ type: constraint, checker }));
 }
 return Boolean(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection)) && !checker.isArrayType(type) && !checker.isTupleType(type) && type.getCallSignatures().length === 0;
}
function options() {
 return { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, skipLibCheck: true, allowJs: true, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2023 };
}
