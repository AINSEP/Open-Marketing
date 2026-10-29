# Provenance

Adapted from `/Users/la/Programming/Tovu/content/agent-plugins/resend` at commit `f0b6151e8b4eda89a43a5698fb28775dbc989494` (Apache-2.0). Source tree clean for this folder and root LICENSE when read. All 12 plugin files and server `runtime/boot/mail-provider-catalog.ts` + `runtime/composition/site-mailer.ts` read. No sibling imports.

Domain/error mappings and fixture expectations derive from the files below. R1F defers the R1 send mapping, DTO, tool, capability and send-only fixtures. Feedback was read but is deferred. Manifest/skill/card are rewritten for OM; no hosted MCP, registry, settings or policy copied. Unlike Tovu: host-injected deadlines, fixed origin, typed read failures and no raw errors or retries. No send behavior remains exposed. LICENSE retains full text with paragraph whitespace reflow only.

| Tovu source | SHA-256 |
|---|---|
| NOTES.md | c7475934a87a05c3c21a0164dab44a3a769ec81dc0cae6f9627c353ad4cda92c |
| __tests__/bundled-mail.test.mjs | 2aa6e3eae525bc502cc21790a0b4c5a7677ee0058f3e08286a728a34ad8e5a10 |
| __tests__/resend-mcp.test.mjs | bc87d03f31f4960f095dc8809059f6cd7f7f8dafa8b1e9b334a016d88e089a92 |
| __tests__/resend.test.mjs | 842847ae7287f80c4aa9ce5935f3bcad9516a331b04f6d41c1a7d707a02668a4 |
| adapters/resend.mjs | fc4c9be3cb748048ea55b5c1b3fa43b90554270d7209ccc6e36eee40ccf58912 |
| lib/domains.mjs | 4b099f8b2c184b0097e3639aab02ae63b09b2fde393e2d1b1fe3833c26c14249 |
| lib/errors.mjs | 28bb77a8727b6f83532f5748514076e939211c20ae21a475de4a9c4d87dde461 |
| lib/feedback.mjs | b1051b2938e21ec8b55d04f2087482345a6354c5557ed3f56717079d36eb6642 |
| mcp.json | 18b1715c1f7d62cc831490b23f9d5ce882454a07f911e0282bf00b25422e14fa |
| plugin.json | dd56e3bbcd850d8ab6a6fbdc97236548747ed926c296c13fabeb0448e8e1582e |
| skills/resend/SKILL.md | 568312fe2a31c2cb8ec81871903cecac2d6aa6820284a7f441dbcbe43ad68b6c |
| tovu-mail-adapters.json | 070d992b757c3c438573816ac5c70c292275fdcb5e562920851fab5518a6ce18 |
| root LICENSE | c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4 |

R2 supersedes R1F's send/feedback deferral for the **programmatic provider**, while assistant send tools and production wiring remain deferred. `src/mail.ts` adapts the payload formatting, relative domain-record qualification and Svix raw-byte/HMAC patterns from the same Tovu `adapters/resend.mjs`, `lib/domains.mjs` and `lib/feedback.mjs` snapshot above. It uses Jini 0.6.12's object ABI, injected clock, fixed origin and strict boundary schemas. Positional send, hidden time reads, retry classification, domain-key fallback and fabricated provider IDs were not carried over. The mail policy/registry/limiter/ingest are imported from the published Jini package, never copied. No sibling source import.
