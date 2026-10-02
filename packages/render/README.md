# @open-marketing/render

Pure `render(input, options?)` produces subject, HTML and text for preview, test-send and dispatch through one function. No providers, database, clock, environment, app wiring or runtime dependencies.

```ts
import { render } from "@open-marketing/render";

const message = render({
  template: {
    id: "welcome", version: 1, purpose: "marketing",
    subject: "Hello {{name}}", html: "<p>Hello {{name}}</p>", text: "Hello {{name}}",
  },
  variables: { name: "Ada" },
  compliance: { unsubscribeUrl: "https://example.test/unsubscribe?signature=caller_signed" },
});
```

## Supported grammar

Placeholders are exactly `{{flat_name}}` (ASCII letter, then up to 63 letters/digits/underscores). Values are own data properties containing strings, finite numbers or booleans. No paths, loops, expressions, raw HTML, getters or recursive substitution. Missing values throw `RenderError` with `MISSING_VARIABLE`.

HTML permits balanced lowercase `p`, `div`, `span`, `strong`, `em`, `b`, `i`, `ul`, `ol`, `li`, `h1`, `h2`, `h3`, `a`, and `br`/`br/`. Only anchors may have an attribute: exactly `<a href="{{url}}">` or a static absolute HTTPS URL. Partial URL interpolation, all other attributes, comments, scripts, styles, SVG and malformed markup are rejected. Text-node variables escape HTML and both quote characters. Plain subject/text remain plain text and must never be mounted as HTML. Subject newlines are rejected.

This is a limited template language, **not a general HTML sanitizer**. Supply template objects as ordinary data, not hostile executable JavaScript objects or Proxies. Static HTML text may contain entities; static URL entities are rejected (use a complete URL variable for query strings). HTTPS URLs are validated then preserved byte-for-byte for signatures. URL validation does not verify signatures, authorize destinations, prevent SSRF or guarantee a link is an unsubscribe endpoint; those are caller responsibilities. No URL is fetched here.

Marketing messages require a caller-provided unsubscribe link by default and append a fixed HTML/text footer. An optional preferences URL gets the same validation. `{ requireMarketingFooter: false }` explicitly disables the requirement; supplied links still produce a footer. Transactional messages do not append a footer. Template identity/version are returned unchanged, but storage immutability and publication policy belong to the caller.

Each template field is limited to 100,000 UTF-16 code units; each scalar string to 10,000; each output field to 1,000,000, including marketing footer. HTML nesting is capped at 128 elements. Invalid/control input fails with typed errors containing no recipient values or signed URLs. Scalar number formatting uses JavaScript's deterministic `String(number)` (including `-0` as `0`).

Run package-scoped `test`, `typecheck`, and `build` scripts. Tests cover deterministic reuse, malicious interpolation, unsupported contexts, repeated substitution limits, missing values and footer rules.
