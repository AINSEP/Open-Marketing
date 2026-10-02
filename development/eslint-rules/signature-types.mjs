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
   analysis ??= programFor({ filename, source });
   const call = nodeAt({ source: analysis.file, start: node.parent.range[0], end: node.parent.range[1], predicate: ts.isCallExpression });
   if (call) return foreignCallArgument({ analysis, call, start: node.range[0] });
   const assignment = nodeAt({ source: analysis.file, start: node.parent.range[0], end: node.parent.range[1], predicate: ts.isBinaryExpression });
   const symbol = assignment && analysis.program.getTypeChecker().getSymbolAtLocation(assignment.left);
   return Boolean(Array.from(symbol?.declarations ?? []).some(declaration => foreignDeclaration({ declaration })));
  }, objectParameter({ parameter }) {
   analysis ??= programFor({ filename, source });
   const node = parameter.type === 'AssignmentPattern' ? parameter.left : parameter;
   const candidate = parameterAt({ source: analysis.file, start: node.range[0] });
   if (!candidate) return false;
   return structuralObject({ type: analysis.program.getTypeChecker().getTypeAtLocation(candidate), checker: analysis.program.getTypeChecker() });
  } };
 } };
}
function foreignCallArgument({ analysis, call, start }) {
 const checker = analysis.program.getTypeChecker();
 if (!foreignDeclaration({ declaration: checker.getResolvedSignature(call)?.declaration })) return false;
 const callback = Array.from(call.arguments).find(argument => argument.getStart(analysis.file) === start);
 const contextual = callback && checker.getContextualType(callback);
 return Boolean(contextual && callableType({ type: contextual }));
}
function callableType({ type }) {
 if (type.isUnion()) return Array.from(type.types).some(item => callableType({ type: item }));
 return type.getCallSignatures().length > 0;
}
function foreignDeclaration({ declaration }) {
 return Boolean(declaration && /\/node_modules\//.test(declaration.getSourceFile().fileName));
}
function nodeAt({ source, start, end, predicate }) {
 let found;
 function visit({ node }) {
  if (predicate(node) && node.getStart(source) === start && node.end === end) found = node;
  if (!found) ts.forEachChild(node, child => visit({ node: child }));
 }
 if (source) visit({ node: source });
 return found;
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
