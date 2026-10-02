import { describe, expect, it } from "vitest";
import { render, RenderError, type MessageTemplate, type RecipientVariables } from "../src/index.js";
const template: MessageTemplate = {
    id: "welcome", version: 2, purpose: "transactional",
    subject: "Hello {{name}}", html: "<p>Hello {{name}}</p>", text: "Hello {{name}}",
};
describe("shared deterministic render", () => {
    it("uses one path for preview and dispatch, preserves version and does not mutate", () => {
        const input = Object.freeze({ template: Object.freeze(template), variables: Object.freeze({ name: "Ada" }) });
        const preview = render(input);
        const dispatch = render(input);
        expect(preview).toEqual(dispatch);
        expect(preview).toEqual({ templateId: "welcome", templateVersion: 2, subject: "Hello Ada", html: "<p>Hello Ada</p>", text: "Hello Ada" });
    });
    it("escapes HTML values without changing text or evaluating inserted tokens", () => {
        const name = `<img src=x onerror='x'> & " {{other}}`;
        const result = render({ template, variables: { name } });
        expect(result.html).toBe("<p>Hello &lt;img src=x onerror=&#39;x&#39;&gt; &amp; &quot; {{other}}</p>");
        expect(result.text).toBe(`Hello ${name}`);
    });
    it("formats scalars without locale or coercing objects", () => {
        const result = render({ template: { ...template, text: "{{a}}/{{b}}/{{c}}/{{d}}" }, variables: { name: "", a: 12.5, b: false, c: -0, d: true } });
        expect(result.text).toBe("12.5/false/0/true");
    });
    it("rejects missing and inherited variables", () => {
        expect(() => render({ template, variables: {} })).toThrowError(expect.objectContaining({ code: "MISSING_VARIABLE" }));
        expect(() => render({ template, variables: Object.create({ name: "inherited" }) })).toThrowError(expect.objectContaining({ code: "MISSING_VARIABLE" }));
    });
    it("does not execute variable getters", () => {
        const variables = Object.defineProperty({}, "name", { get() { throw new Error("executed"); } });
        expect(() => render({ template, variables })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    });
    it.each([null, undefined, {}, [], Infinity, NaN])("rejects invalid scalar %s", (name: {} | null | undefined) => {
        expect(() => render({ template, variables: { name } as unknown as RecipientVariables })).toThrow(RenderError);
    });
    it.each(["{{ name }}", "{{name.x}}", "{{{name}}}", "{{name()}}", "{{#if name}}", "{{name", "name}}"])("rejects unsupported syntax %s", (text: string) => {
        expect(() => render({ template: { ...template, text }, variables: { name: "Ada" } })).toThrowError(expect.objectContaining({ code: "INVALID_SYNTAX" }));
    });
    it.each(["a\nb", "a\rb", "a\u0000b"])("rejects header/control injection", (name: string) => {
        expect(() => render({ template, variables: { name } })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
    });
    it("accepts unicode scalar content", () => {
        expect(render({ template, variables: { name: "Zoë 🌍 العربية" } }).text).toBe("Hello Zoë 🌍 العربية");
    });
    it("bounds source, values and aggregate repeated substitution", () => {
        expect(() => render({ template: { ...template, text: "x".repeat(100001) }, variables: { name: "Ada" } })).toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
        expect(() => render({ template, variables: { name: "x".repeat(10001) } })).toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
        const variables = { name: "x".repeat(10000) };
        expect(render({ template: { ...template, text: "{{name}}".repeat(100) }, variables }).text).toHaveLength(1000000);
        expect(() => render({ template: { ...template, text: "{{name}}".repeat(101) }, variables })).toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
    });
});
describe("restricted HTML and URL contexts", () => {
    it("renders only complete quoted HTTPS URL variables with attribute escaping", () => {
        const result = render({ template: { ...template, html: '<a href="{{url}}">{{name}}</a><br/>' }, variables: { name: "Visit", url: 'https://example.test/u?s=x&v="quoted"' } });
        expect(result.html).toBe('<a href="https://example.test/u?s=x&amp;v=&quot;quoted&quot;">Visit</a><br>');
    });
    it.each(["javascript:alert(1)", "data:text/html,x", "//example.test", "http://example.test", "https://u:p@example.test", "https://", "https://example.test/\nx", "https://example.test\\@evil.test", "javascript&#58;alert(1)"])("rejects unsafe URL %s", (url: string) => {
        expect(() => render({ template: { ...template, html: '<a href="{{url}}">Link</a>' }, variables: { name: "Ada", url } })).toThrow(RenderError);
    });
    it.each([
        '<script>{{name}}</script>', '<style>{{name}}</style>', '<p onclick="{{name}}">x</p>',
        '<p title="{{name}}">x</p>', '<a href={{name}}>x</a>', '<a href="https://example.test/{{name}}">x</a>',
        '<{{name}}>x</{{name}}>', '<!-- {{name}} -->', '<svg><a href="https://example.test">x</a></svg>',
        '<a href="https://example.test"><a href="https://example.test">x</a></a>', '<p>x</div>', '<p>x',
        '<a href="javascript:alert(1)">x</a>', '<a href="https://example.test?a=1&amp;b=2">x</a>', 'x<broken',
    ])("rejects unsupported markup %s", (html: string) => {
        expect(() => render({ template: { ...template, html }, variables: { name: "Ada" } })).toThrow(RenderError);
    });
    it("supports balanced formatting and static HTTPS links", () => {
        const html = '<div><h1>Hi</h1><ul><li><strong>One</strong></li></ul><a href="https://example.test">Visit</a></div>';
        expect(render({ template: { ...template, html }, variables: { name: "Ada" } }).html).toBe(html);
    });
    it("caps nesting depth to bound parser work", () => {
        const html = "<div>".repeat(128) + "text" + "</div>".repeat(128);
        expect(render({ template: { ...template, html }, variables: { name: "Ada" } }).html).toBe(html);
        expect(() => render({ template: { ...template, html: "<div>" + html + "</div>" }, variables: { name: "Ada" } })).toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
    });
    it("rejects a bounded adversarial run of unmatched opening delimiters", () => {
        expect(() => render({ template: { ...template, html: "<".repeat(100000) }, variables: { name: "Ada" } })).toThrowError(expect.objectContaining({ code: "UNSAFE_HTML" }));
    });
});
describe("marketing compliance", () => {
    const marketing = { ...template, purpose: "marketing" } as const;
    it("requires caller-signed unsubscribe link by default", () => {
        expect(() => render({ template: marketing, variables: { name: "Ada" } })).toThrowError(expect.objectContaining({ code: "COMPLIANCE_REQUIRED" }));
        expect(render({ template: marketing, variables: { name: "Ada" } }, { requireMarketingFooter: false }).text).toBe("Hello Ada");
    });
    it("preserves signed bytes in text and escapes links in generated HTML", () => {
        const unsubscribeUrl = "https://example.test/unsubscribe?id=1&sig=a%2Bb";
        const preferencesUrl = "https://example.test/preferences?sig=abc";
        const result = render({ template: marketing, variables: { name: "Ada" }, compliance: { unsubscribeUrl, preferencesUrl } });
        expect(result.text).toBe(`Hello Ada\n\nUnsubscribe: ${unsubscribeUrl}\nPreferences: ${preferencesUrl}`);
        expect(result.html).toContain('href="https://example.test/unsubscribe?id=1&amp;sig=a%2Bb"');
        expect(result.html).toContain(">Preferences</a>");
    });
    it("adds unsubscribe-only footer and rejects unsafe compliance URLs", () => {
        expect(render({ template: marketing, variables: { name: "Ada" }, compliance: { unsubscribeUrl: "https://example.test/u" } }).text).toContain("Unsubscribe:");
        expect(() => render({ template: marketing, variables: { name: "Ada" }, compliance: { unsubscribeUrl: "javascript:alert(1)" } })).toThrowError(expect.objectContaining({ code: "UNSAFE_URL" }));
    });
    it("counts footer bytes toward the output cap", () => {
        expect(() => render({ template: { ...marketing, text: "{{large}}".repeat(100) }, variables: { name: "Ada", large: "x".repeat(10000) }, compliance: { unsubscribeUrl: "https://example.test/u" } })).toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
    });
});
