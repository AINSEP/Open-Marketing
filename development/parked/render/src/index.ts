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
export interface RenderOptions {
    readonly requireMarketingFooter?: boolean;
}
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
    readonly code: RenderErrorCode;
    constructor({ code, message }: {
        code: RenderErrorCode;
        message: string;
    }) {
        super(message);
        this.code = code;
        this.name = "RenderError";
    }
}
const MAX_TEMPLATE = 100000;
const MAX_VALUE = 10000;
const MAX_OUTPUT = 1000000;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
/** Validate bounded strings without coercion. @complexity O(n) time, O(1) space.  */
function boundedString({ value, max }: {
    value: unknown;
    max: number;
}): asserts value is string {
    if (typeof value !== "string")
        throw new RenderError({ code: "INVALID_INPUT", message: "Expected a string" });
    if (value.length > max)
        throw new RenderError({ code: "LIMIT_EXCEEDED", message: "String exceeds render limit" });
    if (CONTROL.test(value))
        throw new RenderError({ code: "INVALID_INPUT", message: "Control characters are unsupported" });
}
/** Encode once at the HTML sink, including both quote delimiters. @complexity O(n) time/space.  */
function escapeHtml({ value }: {
    value: string;
}): string {
    const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return value.replace(/[&<>"']/g, (character) => entities[character]);
}
/** Format JSON scalars without locale, clocks or object coercion. @complexity O(n) time/space.  */
function scalar({ value }: {
    value: unknown;
}): string {
    if (typeof value === "string") {
        boundedString({ value: value, max: MAX_VALUE });
        return value;
    }
    if (typeof value === "boolean")
        return String(value);
    if (typeof value === "number" && Number.isFinite(value))
        return String(value);
    throw new RenderError({ code: "INVALID_INPUT", message: "Variables must be strings, finite numbers or booleans" });
}
/** Read only own data properties; inherited keys/accessors cannot provide variables. @complexity O(1) lookup plus O(value length).  */
function variable({ name, variables }: {
    name: string;
    variables: RecipientVariables;
}): string {
    const property = Object.getOwnPropertyDescriptor(variables, name);
    if (!property)
        throw new RenderError({ code: "MISSING_VARIABLE", message: `Missing variable: ${name}` });
    if (!("value" in property))
        throw new RenderError({ code: "INVALID_INPUT", message: "Accessor variables are unsupported" });
    return scalar({ value: property.value });
}
/** Single-pass substitution: inserted values are never reinterpreted as template syntax. @complexity O(template + output) time/space, capped output.  */
function interpolate({ source, variables, context }: {
    source: string;
    variables: RecipientVariables;
    context: "text" | "html";
}): string {
    if (source.includes("{{{") || source.includes("}}}"))
        throw new RenderError({ code: "INVALID_SYNTAX", message: "Raw interpolation is unsupported" });
    const pieces = source.split(/(\{\{[A-Za-z][A-Za-z0-9_]{0,63}\}\})/g);
    let size = 0;
    return pieces.map((piece) => {
        let output = piece;
        if (piece.startsWith("{{") && piece.endsWith("}}") && NAME.test(piece.slice(2, -2))) {
            output = variable({ name: piece.slice(2, -2), variables: variables });
            if (context === "html")
                output = escapeHtml({ value: output });
        }
        else if (piece.includes("{{") || piece.includes("}}")) {
            throw new RenderError({ code: "INVALID_SYNTAX", message: "Only {{flat_variable}} syntax is supported" });
        }
        size += output.length;
        if (size > MAX_OUTPUT)
            throw new RenderError({ code: "LIMIT_EXCEEDED", message: "Rendered output exceeds limit" });
        return output;
    }).join("");
}
/** Accept absolute HTTPS only, preserving bytes for signed links. No host authorization or SSRF claim. @complexity O(n) time/space.  */
function safeUrl({ value }: {
    value: string;
}): string {
    boundedString({ value: value, max: MAX_VALUE });
    if (!/^https:\/\/[^\s\\]+$/i.test(value))
        throw new RenderError({ code: "UNSAFE_URL", message: "Only absolute HTTPS URLs are supported" });
    let parsed: URL;
    try {
        parsed = new URL(value);
    }
    catch {
        throw new RenderError({ code: "UNSAFE_URL", message: "Invalid URL" });
    }
    if (!parsed.hostname || parsed.username || parsed.password)
        throw new RenderError({ code: "UNSAFE_URL", message: "URL credentials are unsupported" });
    return value;
}
/** Validate one complete anchor; dynamic href must be exactly one placeholder. @complexity O(n) time/space.  */
function renderAnchor({ tag, variables }: {
    tag: string;
    variables: RecipientVariables;
}): string {
    const match = /^<a href="([^"<>]*)">$/.exec(tag);
    if (!match)
        throw new RenderError({ code: "UNSAFE_HTML", message: "Anchor requires only a double-quoted href" });
    const href = match[1];
    const token = /^\{\{([A-Za-z][A-Za-z0-9_]{0,63})\}\}$/.exec(href);
    if (token)
        return `<a href="${escapeHtml({ value: safeUrl({ value: variable({ name: token[1], variables: variables }) }) })}">`;
    if (/[{}&]/.test(href))
        throw new RenderError({ code: "UNSAFE_HTML", message: "Static href cannot contain entities or partial interpolation; use a URL variable" });
    return `<a href="${escapeHtml({ value: safeUrl({ value: href }) })}">`;
}
/** Parse a intentionally small HTML grammar; unsupported markup is rejected, never sanitized. @complexity O(template + output) time/space.  */
function renderHtml({ source, variables }: {
    source: string;
    variables: RecipientVariables;
}): string {
    // Excluding both delimiters prevents repeated scanning of malformed '<' runs.
    const parts = source.split(/(<[^<>]*>)/g);
    const stack: string[] = [];
    let size = 0;
    const output = parts.map((part) => {
        let value: string;
        if (!part.startsWith("<")) {
            if (/[<>]/.test(part))
                throw new RenderError({ code: "UNSAFE_HTML", message: "Malformed HTML delimiter" });
            value = interpolate({ source: part, variables: variables, context: "html" });
        }
        else {
            value = renderTag({ tag: part, variables: variables, stack: stack });
        }
        size += value.length;
        if (size > MAX_OUTPUT)
            throw new RenderError({ code: "LIMIT_EXCEEDED", message: "Rendered HTML exceeds limit" });
        return value;
    }).join("");
    if (stack.length)
        throw new RenderError({ code: "UNSAFE_HTML", message: "Unclosed HTML tag" });
    return output;
}
/** Enforce balanced allowlisted elements and the sole supported attribute context. @complexity O(tag length) time, O(depth) stack space.  */
function renderTag({ tag, variables, stack }: {
    tag: string;
    variables: RecipientVariables;
    stack: string[];
}): string {
    if (stack.length >= 128 && !tag.startsWith("</"))
        throw new RenderError({ code: "LIMIT_EXCEEDED", message: "HTML nesting exceeds 128 elements" });
    if (tag === "<br>" || tag === "<br/>")
        return "<br>";
    if (tag.startsWith("<a ")) {
        if (stack.includes("a"))
            throw new RenderError({ code: "UNSAFE_HTML", message: "Nested anchors are unsupported" });
        stack.push("a");
        return renderAnchor({ tag: tag, variables: variables });
    }
    return renderPlainTag({ tag: tag, stack: stack });
}
/** Validate plain opening/closing tags, mutating only the local parser stack. @complexity O(tag length) time, O(depth) space.  */
function renderPlainTag({ tag, stack }: {
    tag: string;
    stack: string[];
}): string {
    const match = /^<(\/?)(p|div|span|strong|em|b|i|ul|ol|li|h1|h2|h3|a)>$/.exec(tag);
    if (!match || tag === "<a>")
        throw new RenderError({ code: "UNSAFE_HTML", message: "Unsupported HTML element or attribute" });
    if (match[1]) {
        if (stack.pop() !== match[2])
            throw new RenderError({ code: "UNSAFE_HTML", message: "Unbalanced HTML tags" });
    }
    else
        stack.push(match[2]);
    return tag;
}
/** Validate public metadata and templates before evaluating any variables. @complexity O(template length) time, O(1) extra space.  */
function validateTemplate(template: MessageTemplate): void {
    if (!template || typeof template !== "object")
        throw new RenderError({ code: "INVALID_INPUT", message: "Template is required" });
    boundedString({ value: template.id, max: 256 });
    if (!template.id || !Number.isSafeInteger(template.version) || template.version < 1)
        throw new RenderError({ code: "INVALID_INPUT", message: "Invalid template identity or version" });
    if (!["marketing", "transactional"].includes(template.purpose))
        throw new RenderError({ code: "INVALID_INPUT", message: "Invalid template purpose" });
    for (const source of [template.subject, template.html, template.text])
        boundedString({ value: source, max: MAX_TEMPLATE });
}
/** Build a fixed footer; signing and policy decisions remain with the caller. @complexity O(URL length) time/space.  */
function footer(links: ComplianceLinks): {
    html: string;
    text: string;
} {
    const unsubscribe = safeUrl({ value: links.unsubscribeUrl });
    let html = `<p><a href="${escapeHtml({ value: unsubscribe })}">Unsubscribe</a>`;
    let text = `\n\nUnsubscribe: ${unsubscribe}`;
    if (links.preferencesUrl !== undefined) {
        const preferences = safeUrl({ value: links.preferencesUrl });
        html += ` | <a href="${escapeHtml({ value: preferences })}">Preferences</a>`;
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
 *
 */
export function render(input: RenderInput, options: RenderOptions = {}): RenderedMessage {
    if (!input || typeof input !== "object")
        throw new RenderError({ code: "INVALID_INPUT", message: "Render input is required" });
    validateTemplate(input.template);
    if (!input.variables || typeof input.variables !== "object" || Array.isArray(input.variables))
        throw new RenderError({ code: "INVALID_INPUT", message: "Variables must be a record" });
    return renderValidated(input, options);
}
/** Assemble content and enforce header/footer rules. @complexity O(template + output) time/space.  */
function renderValidated(input: RenderInput, options: RenderOptions): RenderedMessage {
    const { template, variables } = input;
    const subject = interpolate({ source: template.subject, variables: variables, context: "text" });
    if (/[\r\n]/.test(subject))
        throw new RenderError({ code: "INVALID_INPUT", message: "Subject cannot contain newlines" });
    const message = { templateId: template.id, templateVersion: template.version, subject, html: renderHtml({ source: template.html, variables: variables }), text: interpolate({ source: template.text, variables: variables, context: "text" }) };
    if (template.purpose !== "marketing")
        return message;
    return applyMarketingFooter({ message: message, links: input.compliance, options: options });
}
/** Apply explicit marketing footer policy without interpreting caller-provided links as HTML. @complexity O(output + URLs) time/space.  */
function applyMarketingFooter({ message, links, options }: {
    message: RenderedMessage;
    links: ComplianceLinks | undefined;
    options: RenderOptions;
}): RenderedMessage {
    if (!links) {
        if (options.requireMarketingFooter !== false)
            throw new RenderError({ code: "COMPLIANCE_REQUIRED", message: "Marketing unsubscribe link is required" });
        return message;
    }
    const suffix = footer(links);
    if (message.html.length + suffix.html.length > MAX_OUTPUT || message.text.length + suffix.text.length > MAX_OUTPUT)
        throw new RenderError({ code: "LIMIT_EXCEEDED", message: "Footer exceeds output limit" });
    return { ...message, html: message.html + suffix.html, text: message.text + suffix.text };
}
