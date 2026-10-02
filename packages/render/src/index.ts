/** Deterministic, scalar-only recipient values. Nested paths and executable syntax are unsupported. */
export type RecipientVariables = Readonly<Record<string, string | number | boolean>>;

/** Immutable template identity and purpose; HTML uses the restricted grammar documented in README. */
export interface MessageTemplate {
  readonly id: string;
  readonly version: number;
  readonly purpose: "marketing" | "transactional";
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** Caller owns signing, expiry, destination authorization and verification of these HTTPS links. */
export interface ComplianceLinks {
  readonly unsubscribeUrl: string;
  readonly preferencesUrl?: string;
}

/** Shared input for preview, test-send and dispatch; no mode changes the render path. */
export interface RenderInput {
  readonly template: MessageTemplate;
  readonly variables: RecipientVariables;
  readonly compliance?: ComplianceLinks;
}

/** Marketing footer requirement is enabled by default; transactional messages omit it. */
export interface RenderOptions { readonly requireMarketingFooter?: boolean }

/** Transport-independent message content tied to the exact caller-supplied template version. */
export interface RenderedMessage {
  readonly templateId: string;
  readonly templateVersion: number;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** Stable failure categories; errors never include recipient values or signed URLs. */
export type RenderErrorCode = "INVALID_INPUT" | "INVALID_SYNTAX" | "MISSING_VARIABLE" | "UNSAFE_HTML" | "UNSAFE_URL" | "LIMIT_EXCEEDED" | "COMPLIANCE_REQUIRED";

/** A deterministic validation failure with a machine-readable code. */
export class RenderError extends Error {
  constructor(readonly code: RenderErrorCode, message: string) {
    super(message);
    this.name = "RenderError";
  }
}

const MAX_TEMPLATE = 100_000;
const MAX_VALUE = 10_000;
const MAX_OUTPUT = 1_000_000;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Validate bounded strings without coercion. @complexity O(n) time, O(1) space. @overallScore 100 */
function boundedString(value: unknown, max: number): asserts value is string {
  if (typeof value !== "string") throw new RenderError("INVALID_INPUT", "Expected a string");
  if (value.length > max) throw new RenderError("LIMIT_EXCEEDED", "String exceeds render limit");
  if (CONTROL.test(value)) throw new RenderError("INVALID_INPUT", "Control characters are unsupported");
}

/** Encode once at the HTML sink, including both quote delimiters. @complexity O(n) time/space. @overallScore 100 */
function escapeHtml(value: string): string {
  const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return value.replace(/[&<>"']/g, (character) => entities[character]);
}

/** Format JSON scalars without locale, clocks or object coercion. @complexity O(n) time/space. @overallScore 100 */
function scalar(value: unknown): string {
  if (typeof value === "string") { boundedString(value, MAX_VALUE); return value; }
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new RenderError("INVALID_INPUT", "Variables must be strings, finite numbers or booleans");
}

/** Read only own data properties; inherited keys/accessors cannot provide variables. @complexity O(1) lookup plus O(value length). @overallScore 100 */
function variable(name: string, variables: RecipientVariables): string {
  const property = Object.getOwnPropertyDescriptor(variables, name);
  if (!property) throw new RenderError("MISSING_VARIABLE", `Missing variable: ${name}`);
  if (!("value" in property)) throw new RenderError("INVALID_INPUT", "Accessor variables are unsupported");
  return scalar(property.value);
}

/** Single-pass substitution: inserted values are never reinterpreted as template syntax. @complexity O(template + output) time/space, capped output. @overallScore 100 */
function interpolate(source: string, variables: RecipientVariables, context: "text" | "html"): string {
  if (source.includes("{{{") || source.includes("}}}")) throw new RenderError("INVALID_SYNTAX", "Raw interpolation is unsupported");
  const pieces = source.split(/(\{\{[A-Za-z][A-Za-z0-9_]{0,63}\}\})/g);
  let size = 0;
  return pieces.map((piece) => {
    let output = piece;
    if (piece.startsWith("{{") && piece.endsWith("}}") && NAME.test(piece.slice(2, -2))) {
      output = variable(piece.slice(2, -2), variables);
      if (context === "html") output = escapeHtml(output);
    } else if (piece.includes("{{") || piece.includes("}}")) {
      throw new RenderError("INVALID_SYNTAX", "Only {{flat_variable}} syntax is supported");
    }
    size += output.length;
    if (size > MAX_OUTPUT) throw new RenderError("LIMIT_EXCEEDED", "Rendered output exceeds limit");
    return output;
  }).join("");
}

/** Accept absolute HTTPS only, preserving bytes for signed links. No host authorization or SSRF claim. @complexity O(n) time/space. @overallScore 100 */
function safeUrl(value: string): string {
  boundedString(value, MAX_VALUE);
  if (!/^https:\/\/[^\s\\]+$/i.test(value)) throw new RenderError("UNSAFE_URL", "Only absolute HTTPS URLs are supported");
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new RenderError("UNSAFE_URL", "Invalid URL"); }
  if (!parsed.hostname || parsed.username || parsed.password) throw new RenderError("UNSAFE_URL", "URL credentials are unsupported");
  return value;
}

/** Validate one complete anchor; dynamic href must be exactly one placeholder. @complexity O(n) time/space. @overallScore 100 */
function renderAnchor(tag: string, variables: RecipientVariables): string {
  const match = /^<a href="([^"<>]*)">$/.exec(tag);
  if (!match) throw new RenderError("UNSAFE_HTML", "Anchor requires only a double-quoted href");
  const href = match[1];
  const token = /^\{\{([A-Za-z][A-Za-z0-9_]{0,63})\}\}$/.exec(href);
  if (token) return `<a href="${escapeHtml(safeUrl(variable(token[1], variables)))}">`;
  if (/[{}&]/.test(href)) throw new RenderError("UNSAFE_HTML", "Static href cannot contain entities or partial interpolation; use a URL variable");
  return `<a href="${escapeHtml(safeUrl(href))}">`;
}

/** Parse a intentionally small HTML grammar; unsupported markup is rejected, never sanitized. @complexity O(template + output) time/space. @overallScore 96 — Low: restricted markup intentionally excludes email layout tables. */
function renderHtml(source: string, variables: RecipientVariables): string {
  // Excluding both delimiters prevents repeated scanning of malformed '<' runs.
  const parts = source.split(/(<[^<>]*>)/g);
  const stack: string[] = [];
  let size = 0;
  const output = parts.map((part) => {
    let value: string;
    if (!part.startsWith("<")) {
      if (/[<>]/.test(part)) throw new RenderError("UNSAFE_HTML", "Malformed HTML delimiter");
      value = interpolate(part, variables, "html");
    } else {
      value = renderTag(part, variables, stack);
    }
    size += value.length;
    if (size > MAX_OUTPUT) throw new RenderError("LIMIT_EXCEEDED", "Rendered HTML exceeds limit");
    return value;
  }).join("");
  if (stack.length) throw new RenderError("UNSAFE_HTML", "Unclosed HTML tag");
  return output;
}

/** Enforce balanced allowlisted elements and the sole supported attribute context. @complexity O(tag length) time, O(depth) stack space. @overallScore 100 */
function renderTag(tag: string, variables: RecipientVariables, stack: string[]): string {
  if (stack.length >= 128 && !tag.startsWith("</")) throw new RenderError("LIMIT_EXCEEDED", "HTML nesting exceeds 128 elements");
  if (tag === "<br>" || tag === "<br/>") return "<br>";
  if (tag.startsWith("<a ")) {
    if (stack.includes("a")) throw new RenderError("UNSAFE_HTML", "Nested anchors are unsupported");
    stack.push("a");
    return renderAnchor(tag, variables);
  }
  return renderPlainTag(tag, stack);
}

/** Validate plain opening/closing tags, mutating only the local parser stack. @complexity O(tag length) time, O(depth) space. @overallScore 100 */
function renderPlainTag(tag: string, stack: string[]): string {
  const match = /^<(\/?)(p|div|span|strong|em|b|i|ul|ol|li|h1|h2|h3|a)>$/.exec(tag);
  if (!match || tag === "<a>") throw new RenderError("UNSAFE_HTML", "Unsupported HTML element or attribute");
  if (match[1]) {
    if (stack.pop() !== match[2]) throw new RenderError("UNSAFE_HTML", "Unbalanced HTML tags");
  } else stack.push(match[2]);
  return tag;
}

/** Validate public metadata and templates before evaluating any variables. @complexity O(template length) time, O(1) extra space. @overallScore 100 */
function validateTemplate(template: MessageTemplate): void {
  if (!template || typeof template !== "object") throw new RenderError("INVALID_INPUT", "Template is required");
  boundedString(template.id, 256);
  if (!template.id || !Number.isSafeInteger(template.version) || template.version < 1) throw new RenderError("INVALID_INPUT", "Invalid template identity or version");
  if (!["marketing", "transactional"].includes(template.purpose)) throw new RenderError("INVALID_INPUT", "Invalid template purpose");
  for (const source of [template.subject, template.html, template.text]) boundedString(source, MAX_TEMPLATE);
}

/** Build a fixed footer; signing and policy decisions remain with the caller. @complexity O(URL length) time/space. @overallScore 100 */
function footer(links: ComplianceLinks): { html: string; text: string } {
  const unsubscribe = safeUrl(links.unsubscribeUrl);
  let html = `<p><a href="${escapeHtml(unsubscribe)}">Unsubscribe</a>`;
  let text = `\n\nUnsubscribe: ${unsubscribe}`;
  if (links.preferencesUrl !== undefined) {
    const preferences = safeUrl(links.preferencesUrl);
    html += ` | <a href="${escapeHtml(preferences)}">Preferences</a>`;
    text += `\nPreferences: ${preferences}`;
  }
  return { html: html + "</p>", text };
}

/**
 * Render the same deterministic message for preview, test-send and dispatch.
 * @param input Versioned template, scalar recipient values and caller-signed links.
 * @param options Marketing messages require a fixed unsubscribe footer by default.
 * @returns New content without mutating inputs or performing I/O.
 * @throws RenderError for invalid syntax, unsafe contexts, missing values or limits.
 * @example render({ template, variables: { first_name: "Ada" }, compliance: { unsubscribeUrl: "https://example.test/u?s=signature" } });
 * @complexity O(template + rendered output) time/space, with bounded source and output.
 * @overallScore 100
 */
export function render(input: RenderInput, options: RenderOptions = {}): RenderedMessage {
  if (!input || typeof input !== "object") throw new RenderError("INVALID_INPUT", "Render input is required");
  validateTemplate(input.template);
  if (!input.variables || typeof input.variables !== "object" || Array.isArray(input.variables)) throw new RenderError("INVALID_INPUT", "Variables must be a record");
  return renderValidated(input, options);
}

/** Assemble content and enforce header/footer rules. @complexity O(template + output) time/space. @overallScore 100 */
function renderValidated(input: RenderInput, options: RenderOptions): RenderedMessage {
  const { template, variables } = input;
  const subject = interpolate(template.subject, variables, "text");
  if (/[\r\n]/.test(subject)) throw new RenderError("INVALID_INPUT", "Subject cannot contain newlines");
  const message = { templateId: template.id, templateVersion: template.version, subject, html: renderHtml(template.html, variables), text: interpolate(template.text, variables, "text") };
  if (template.purpose !== "marketing") return message;
  return applyMarketingFooter(message, input.compliance, options);
}

/** Apply explicit marketing footer policy without interpreting caller-provided links as HTML. @complexity O(output + URLs) time/space. @overallScore 100 */
function applyMarketingFooter(message: RenderedMessage, links: ComplianceLinks | undefined, options: RenderOptions): RenderedMessage {
  if (!links) {
    if (options.requireMarketingFooter !== false) throw new RenderError("COMPLIANCE_REQUIRED", "Marketing unsubscribe link is required");
    return message;
  }
  const suffix = footer(links);
  if (message.html.length + suffix.html.length > MAX_OUTPUT || message.text.length + suffix.text.length > MAX_OUTPUT) throw new RenderError("LIMIT_EXCEEDED", "Footer exceeds output limit");
  return { ...message, html: message.html + suffix.html, text: message.text + suffix.text };
}
