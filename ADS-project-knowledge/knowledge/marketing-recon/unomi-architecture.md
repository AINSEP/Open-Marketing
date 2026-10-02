# Apache Unomi Architecture — Reference Analysis

> Reference-only analysis of upstream Apache Unomi, done to decide **what to port** into the
> Open Design–based Open Marketing repo. We will not run a JVM or OSGi container — judge port
> value on the **domain model and specification**, not on liftable code.
>
> - **Source:** `/Users/la/Programming/OSS-Marketing-Repos/unomi` (clone of
>   `github.com/apache/unomi`, analyzed at commit `b1b73db8`, 2026-07-01, version
>   `3.1.0-SNAPSHOT` on the `main` branch)
> - **Tools:** codebase-memory-mcp (project `unomi`, moderate mode) + graphify (`graphify-out/`,
>   Tree-sitter, no LLM) + direct source reads. Two independent engines as a cross-check.
> - **Date:** 2026-09-06

## Section 0 — Premise corrections and self-corrections

Every one of these came from reading source, not from the brief. Look first, then trust.

1. **"Unomi has a public context endpoint by design" is no longer true of this codebase as a
   blanket statement — this is the single biggest correction in this report.** The dispatch
   brief's framing matches classic/released Unomi (≤2.x/3.0), but commit `b1b73db8` is
   mid-flight on an **unreleased multi-tenant rearchitecture**. By default, `/context.json`,
   `/eventcollector`, and `/client/*` are "public" only in the sense that
   `AuthenticationFilter.isPublicPath()` (`rest/src/main/java/org/apache/unomi/rest/authentication/AuthenticationFilter.java:351-362`)
   routes them to a check for a valid **tenant public API key** (`X-Unomi-Api-Key` header,
   resolved via `TenantService.getTenantByApiKey(apiKey, ApiKeyType.PUBLIC)`,
   `AuthenticationFilter.java:161-181`). No key, or an invalid one, falls through to Basic
   Auth/JAAS, and failing that returns a bare `401`. The old, fully-unauthenticated behavior
   only exists behind an explicit, **disabled-by-default** `v2CompatibilityModeEnabled` flag
   (`DefaultRestAuthenticationConfig.java:76`, `AuthenticationFilter.java:259-330`). Establish
   exactly what a fresh Unomi checkout exposes before citing "public by design" anywhere else in
   this survey — it depends entirely on which era of Unomi you mean.
2. **The clone is the unstable dev branch, not a release — treat multi-tenancy as in-progress,
   not as Unomi's settled architecture.** `README.md:29-31` says so explicitly ("main (master)
   branch: is the current development branch and should be considered unstable... might even
   not compile"), and `pom.xml:33` confirms `3.1.0-SNAPSHOT`. The tenant model
   (`TenantService`, `ApiKey`, `ExecutionContextManager.executeAsTenant/executeAsSystem`, the
   `X-Unomi-Tenant-Id` header) is a substantial, structurally coherent addition (graphify
   Community 34, cohesion 0.05: `ApiKey`, `Tenant`, `TenantServiceImpl`,
   `TenantLifecycleListener`) layered on top of the historically single-tenant OASIS Context
   Server design — not vestigial, not a fork artifact, but also not something released Unomi
   3.0.x or earlier has at all. Any comparison to "classic Unomi" behavior needs this caveat.
3. **cbm's `hotspots` fan-in numbers are mostly trustworthy here, unlike on Chatwoot/Mautic —
   but verify per-symbol, don't assume.** `Item.getItemId` (fan-in 440) and
   `Item.setItemId` (417) each have exactly **one** definition
   (`api/src/main/java/org/apache/unomi/api/Item.java`) — these are real hub numbers, not
   name-collision noise, because `Item` is the single base class of `Profile`/`Session`/
   `Event`/`Segment`/etc. But the risk flagged in the brief is real for *some* names in the
   same hotspot list: `get` has **38** separate definitions, `getConditionType` has **7**,
   `executeAsSystem` **4**, `executeAsTenant` **3**, `getLogger` **3**, `getMetadata` and
   `setParameter` **2** each. The `getConditionType` fan-in of 171 attributed to
   `DefinitionsServiceEndPoint.getConditionType` in `get_architecture`'s hotspot list is
   suspect for exactly this reason — it is likely a collapsed sum across 7 same-named methods,
   not one method's true fan-in. Confirmed by direct query
   (`MATCH (m) WHERE m.name IN [...] RETURN m.name, count(m)`), not assumption.
4. **cbm's cognitive-complexity and loop metrics ARE populated on Java** — confirmed by
   direct count, not sampling: 2,207 of 8,520 `Method`/`Function` nodes have non-zero
   `cognitive`, and 2,704 have non-zero `transitive_loop_depth`. This differs from the Ruby
   result on Chatwoot (all-zero loop metrics) and matches the TypeScript result on Dittofeed —
   the earlier hypothesis that this is a **per-language**, not per-repo, gap holds a third time.
   The worst offender, `PropertyConditionEvaluator.isMatch` at cognitive **651**
   (`plugins/baseplugin/src/main/java/.../PropertyConditionEvaluator.java:288-486`), was read in
   full to confirm the number is real and not a tool artifact: it is a genuine 199-line,
   61-branch `if`/`else-if` chain, not a formatting quirk. See "What's weak" below for why.
5. **cbm `Route` nodes are largely unusable here too, but for a different reason than
   Chatwoot's Rails DSL.** 102 `Route` nodes exist, but only 4 carry a real HTTP
   method+path+file (the `@GET/@POST/@DELETE/@PUT @Path("/")` JAX-RS annotations on
   `GeonamesEndPoint`, `GroovyActionsEndPoint`, and `ProfileServiceEndPoint`). The remaining ~98
   are noise from two unrelated sources the extractor folded into the same label: (a) test
   fixture path strings (`/test-segments/test-segment.json`, `/other/path`) and (b) **Kafka
   consumer config keys** (`bootstrap.servers`, `group.id`, `ssl.truststore.password`, …) tagged
   with `broker: "kafka"` — config keys, not routes. **Verify per-framework, not per-tool, and
   per-annotation-style within a framework**: JAX-RS annotation extraction itself is fine (the
   4 real ones are accurate down to the HTTP verb), but the rest of the CXF/JAX-RS surface in
   this codebase is registered by dynamic OSGi service properties
   (`@Component(property = "osgi.jaxrs.resource=true")`) rather than a single scanned base
   path, so most real endpoints have no `Route` node at all. The actual 24 REST endpoint
   classes were found by `search_code` on file names, not the graph.
6. **graphify's god-node list is clean here — no manifest-key pollution**, unlike Chatwoot
   (`vue`, 733 edges) and Mautic (`composer.json`, 694 nodes). The top 10
   (`Condition` 817, `Event` 361, `Profile` 358, `Metadata` 330, `Query` 259, `PartialList` 243,
   `Item` 238, `ScheduledTask` 236, `InMemoryPersistenceServiceImpl` 208, `PersistenceService`
   205) are all genuine domain types. This is a useful independent confirmation that `Condition`
   — not `Profile` — is the true center of gravity of this codebase, matching the OASIS spec's
   framing and the cbm fan-in data on `Condition.setParameter`/`setConditionTypeId`.
7. **graphify's community detection picked up non-code list items as "nodes" — a new noise
   mode not seen on Chatwoot/Dittofeed.** Community 75 (48 members) is literally the numbered
   headings of a markdown roadmap doc ("1. Migrate from Blueprint to DS Annotations", "2. Merge
   Plugins and Extensions", …), and Community 94 (41 members) is numbered sections from
   `rest/postman-readme.md` / the Postman collection ("10. Explain Context Request", "11.
   Profile Management", …). Neither pollutes the god-node ranking (both are 1-2 edges each,
   nowhere near the top 10), but they do inflate the community count and would mislead anyone
   skimming the community list for "what modules exist." Filter numbered markdown headings
   before reading graphify communities as an architecture map on a repo with prose docs
   committed alongside code.

## TL;DR

- **Code quality: 6/10. Marketing port value: 3/10 for code, 8/10 for the specification and
  domain model treated as a spec to reimplement.** Unomi is not a marketing-automation
  platform — it is a **CDP / profile-and-event store** implementing a real, cross-vendor
  standard (the OASIS Context Server spec). It has no journey builder, no campaign/sequence
  engine, no email-sending pipeline, and no send-time logic of any kind. What it has instead —
  and this is the entire reason to read it — is the **most rigorously specified condition,
  segment, and consent model in the 12-repo set**, with a clean declarative representation, a
  dual evaluation/query-translation split, and a genuine (if OSGi-bound) extensibility story.
- **The condition/rule/segment layer is the crown jewel; nearly everything else is JVM/OSGi/
  Elasticsearch plumbing that does not survive a port.** `Condition` is a typed tree
  (`conditionTypeId` + a flat parameter map, optionally nesting more `Condition`s) that gets
  interpreted **two different ways from the same data**: an in-memory `ConditionEvaluator` for
  real-time rule/segment matching, and a separate `ConditionOSQueryBuilder`/
  `ConditionESQueryBuilder` for translating the identical tree into a search-engine query. Both
  paths are pluggable via the same declarative `ConditionType` record
  (`conditionEvaluator` id + `queryBuilder` id), which is the single best idea to take from this
  repo.
- **Extensibility is a genuinely three-tier model**, not just "OSGi components": (1) native Java
  via `@Component`-registered `ConditionEvaluator`/`ActionExecutor` services, (2) **declarative
  JSON manifests** dropped under `META-INF/cxs/{conditions,actions,properties,rules,segments,
  scoring}/*.json` inside any bundle, auto-loaded/unloaded on OSGi bundle start/stop
  (`AbstractMultiTypeCachingService.bundleChanged`, `services-common/src/main/java/org/apache/
  unomi/services/common/cache/AbstractMultiTypeCachingService.java`), and (3) **dynamically
  compiled Groovy scripts** dropped as `.groovy` files under the same convention, needing
  neither a compile step nor a bundle rebuild. The "drop a manifest file, get a registered
  extension" pattern is worth copying into a Node/TS world even with zero OSGi underneath it.
- **This clone is not representative of released Unomi** — it is an unstable dev-branch commit
  mid-rearchitecture toward multi-tenancy and away from the historically fully-open context
  endpoint. Read every claim about "how Unomi behaves" in this document as "how this exact
  commit behaves," not as settled project behavior.

## What it is

Apache Unomi is a **Java 11+ / OSGi (Apache Karaf) / Maven multi-module** project — a reference
implementation of the OASIS Context Server specification, providing a "high-performance user
profile and event tracking server" (`pom.xml:27-29`). 1,792 tracked files, 940 `.java` (848 main,
92 test by directory split), plus Groovy, Bash, and YAML. Apache 2.0 throughout, no dual-license
tier (unlike Chatwoot's `enterprise/`) — a `license-mappings.xml` at the root exists only to
declare third-party bundled-dependency licenses for release compliance, not to gate features.

cbm indexed **26,274 nodes / 96,566 edges** (moderate mode, 848 Java files + Bash/YAML/Groovy,
9 dirs auto-excluded: `tools`, `samples`, `.git`, generated resource/asset dirs). graphify:
**12,767 nodes / 48,381 edges**, 459 communities (181 thin omitted), **85% EXTRACTED / 15%
INFERRED / 0% AMBIGUOUS**, **zero import cycles detected**, $0 LLM cost.

### Module layout

Top-level Maven modules: `api` (the domain model, no impl), `common`, `services-common`
(shared OSGi/tenant/caching infra), `services` (the service implementations — rules, segments,
profiles, events, definitions), `persistence-spi` (persistence-agnostic SPI: condition
evaluators, query-builder dispatch contracts), `persistence-elasticsearch` and
`persistence-opensearch` (two **fully parallel, independently maintained** backend
implementations — see "What's weak" #1), `rest` (JAX-RS/CXF REST layer), `graphql` (a
CDP-flavored GraphQL schema and resolvers, `graphql/cxs-impl`), `web-servlets`, `scripting`
(Groovy script execution SPI), `tracing` (a custom lightweight request tracer, not
OpenTelemetry), `lifecycle-watcher` (bundle-startup health gating for Karaf), `metrics`,
`plugins/{baseplugin, advanced-conditions, hover-event, kafka-injector, mail,
optimization-test, request, tracked-event}` (8 plugin bundles), `extensions/{geonames,
groovy-actions, healthcheck, json-schema, lists-extension, log4j-extension, privacy-extension,
router, salesforce-connector, weather-update, web-tracker}` (11 extension bundles),
`distribution`/`kar`/`package` (Karaf assembly), and `itests` (integration tests, run inside a
live Karaf container via Pax Exam — 60 `*IT.java` files, 133 test files total by directory
count). 46 `<module>` entries in the root `pom.xml`; ~89 `pom.xml` files in the full tree.

Dependency direction (cbm `boundaries`): `cxs-impl → src` (483 calls), `baseplugin → src` (387),
`src → core` (162), `json-schema → src` (130), `router → src` (97) — a conventional
plugin/extension-bundle-depends-on-core shape, no cycles either engine could find.

## HTTP/API surface

Two parallel API surfaces, both gated by the same `AuthenticationFilter`:

1. **REST (JAX-RS/CXF), ~24 endpoint classes** under `rest/src/main/java/org/apache/unomi/rest/
   endpoints/`: `ContextJsonEndpoint` (the public tracking/personalization entry point),
   `EventsCollectorEndpoint`, `ProfileServiceEndPoint`, `SegmentsServiceEndPoint`,
   `RulesServiceEndPoint`, `DefinitionsServiceEndPoint`, `TaskEndpoint`, `TenantEndpoint`
   (admin-only tenant/API-key management), and more. Registered dynamically via
   `@Component(service = X.class, property = "osgi.jaxrs.resource=true")` rather than a single
   scanned annotation surface — this is why the graph's `Route` extraction mostly fails (see
   Section 0 #5).
2. **GraphQL** (`graphql/cxs-impl`, `graphql-java`) exposing a CDP-shaped schema (`CDPProfile`,
   `CDPEvent`, `CDPSegment`, `CDPConsent`, …) — a second, independently-authenticated surface
   (`GraphQLServletSecurityValidator`, its own `AuthType` handling in itests) sitting over the
   same `ProfileService`/`SegmentService`/`EventService` core.

**Auth model (see Section 0 #1–2 for the caveat that this is new/unreleased):**
`AuthenticationFilter` (`@PreMatching @Priority(Priorities.AUTHENTICATION)`,
`rest/src/main/java/org/apache/unomi/rest/authentication/AuthenticationFilter.java`) is the
single choke point for every REST call. It tries, in order: (a) `tenants/*` paths → JAAS Basic
Auth only, full admin; (b) "public path" patterns (`context\.js(on)`, `eventcollector`,
`client/.*`, from `DefaultRestAuthenticationConfig.PUBLIC_PATH_PATTERNS`) → look up a tenant by
a **public** `X-Unomi-Api-Key`; (c) everything else → tenant **private** key via HTTP Basic
(`tenantId:privateKey`), falling back to JAAS. No valid credential of any kind → bare `401`. A
`v2CompatibilityModeEnabled` flag (off by default) restores the historical fully-open
`/context.json` behavior with a configured default tenant, for migrating v2 API consumers.
Per-method role requirements are a hand-maintained `Map<String,String>`
(`DefaultRestAuthenticationConfig.ROLES_MAPPING`), not annotations — `ContextJsonEndpoint`'s
four HTTP-verb variants and `EventsCollectorEndpoint` map to `ROLE_UNOMI_TENANT_USER`
("guest"); `TenantEndpoint`'s six methods all require `ROLE_UNOMI_ADMIN`.

## Event ingestion, traced end to end

`ContextJsonEndpoint.contextJSONAsPost` (`rest/src/main/java/org/apache/unomi/rest/endpoints/
ContextJsonEndpoint.java:149-238`) is the canonical entry point (`contextJSAsGet`/`contextJSAsPost`/
`contextJSONAsGet` all delegate to it). Trace:

1. **Schema-validate** the `personaId`/`sessionId` query params against a JSON Schema
   (`SchemaService.isValid`) — throws `InvalidRequestException` (→ 400) on failure.
2. **`RestServiceUtilsImpl.initEventsRequest`** (`rest/src/main/java/org/apache/unomi/rest/
   service/impl/RestServiceUtilsImpl.java:114-258`) resolves identity: persona lookup by
   `personaId`, else profile-cookie lookup, else load-by-`profileId`, else **synthesize a new
   `Profile`** (`UUID.randomUUID()`, `firstVisit` property set) — this is the "anonymous visitor"
   bootstrap. Session resolution follows the same load-or-create pattern, additionally handling
   an anonymous-browsing profile swap driven by `PrivacyService.isRequireAnonymousBrowsing`. A
   new session triggers a synthetic `sessionCreated` event (persistent), and a new profile
   triggers a synthetic `profileUpdated` event (non-persistent) — **both go through the same
   `EventService.send()` pipeline as user-submitted events**, not a side channel.
3. **`RestServiceUtilsImpl.performEventsRequest`** iterates the request's `events[]`. Each event
   is rebuilt server-side from client-supplied fields (never trusting a client-supplied
   `itemId` unless the caller holds `ROLE_UNOMI_TENANT_ADMIN`), checked against
   `EventService.isEventAllowedForTenant` (or, in V2-compatibility mode, an IP+
   `X-Unomi-Peer`-key check via `V2ThirdPartyConfigService` for a fixed list of "protected"
   event types), checked against the profile's `filteredEventTypes` (opt-out), and then handed
   to **`EventServiceImpl.send(Event)`**.
4. **`EventServiceImpl.send`/`sendInternal`**
   (`services/src/main/java/org/apache/unomi/services/impl/events/EventServiceImpl.java`) is a
   **synchronous, in-thread pipeline** with a `ThreadLocal` recursion guard
   (`MAX_RECURSION_DEPTH = 20`, loop-chain detection to avoid infinite event-triggers-event
   storms). `sendInternal` persists the event (`persistenceService.save`, if
   `event.isPersistent()`), then iterates all bound `EventListenerService`s whose `canHandle`
   returns true, calling `onEvent(Event)` on each. **`RulesServiceImpl` is one such listener** —
   this is the hook into the rule engine (see next section). If the profile or session changed
   as a side effect, `send()` recurses on a synthetic `profileUpdated`/`sessionUpdated` event
   (confirmed `recursive: true` on the `send` graph node).
5. **`RestServiceUtilsImpl.finalizeEventsRequest`** persists the profile
   (`profileService.save`) and/or session (`profileService.saveSession`) **only if the
   accumulated bitmask of changes says so** (`EventService.PROFILE_UPDATED` /
   `SESSION_UPDATED`), and sets the profile-id cookie on the HTTP response.

**Consistency guarantee: fully synchronous, single-request, best-effort.** There is no queue, no
outbox, no async worker in this path — persistence, rule matching, action execution, and
response construction all happen on the calling HTTP thread before the response is written. A
crash mid-request can persist the event but lose the profile/session update (or vice versa,
depending on which `save` call the crash lands before) — there is no transactional envelope
across `Event`/`Profile`/`Session` writes to Elasticsearch/OpenSearch. Compare Dittofeed's
Temporal-durable journey engine, which has none of this fragility; Unomi's ingestion path has
none of Dittofeed's durability story.

## The profile/session model

`Profile extends Item` (`api/src/main/java/org/apache/unomi/api/Profile.java`) carries a flat
`properties: Map<String,Object>`, a separate `systemProperties` map (used for internal
denormalized state — see `pastEvents` below), a `segments: Set<String>` and
`scores: Map<String,Integer>` (both **denormalized onto the profile**, not computed on read —
see next section), and `consents: Map<String,Consent>`. There is no first-class "trait" schema
beyond `PropertyType` (see below) — arbitrary properties can be set at any time.

`Session extends Item` (`api/src/main/java/org/apache/unomi/api/Session.java`) holds a
`profileId` **and** an embedded `profile` reference, its own `properties`, `duration`, `size`,
and `originEventIds`/`originEventTypes` (which events opened/extended it). Anonymous-browsing
handling lives at the session layer: `RestServiceUtilsImpl.initEventsRequest` swaps the
session's embedded profile between the real profile and an anonymized shadow profile
(`PrivacyService.getAnonymousProfile`) depending on the profile's current anonymity preference,
without changing the session's identity.

**Identity stitching is cookie + explicit-id, not device-fingerprint-based.** A returning
visitor is recognized by a `profileId` cookie (`RestServiceUtilsImpl.getProfileIdCookieValue`);
there is no separate "alias" merge engine visible in the core flow analyzed here beyond
`Profile.mergedWith` (explicitly `@Deprecated` — "merge mechanism is now based on profile
aliases") — a `ProfileAlias` type exists (graphify Community 31:
`AddAliasToProfileCommand`/`RemoveAliasFromProfileCommand`) for explicit alias linking, invoked
by the caller rather than inferred automatically.

**Property typing/extension:** `PropertyType extends MetadataItem`
(`api/src/main/java/org/apache/unomi/api/PropertyType.java`) declares a `valueTypeId`
(indirection to a `ValueType` registry — the actual coercion/validation logic is pluggable, not
enumerated), optional `dateRanges`/`numericRanges`/`ipRanges` constraints, `multivalued`,
`protekted` (read-only) flag, a `mergeStrategy` id (pluggable `PropertyMergeStrategyType` —
`AddPropertyMergeStrategyExecutor`, `MostRecentPropertyMergeStrategyExecutor`,
`OldestPropertyMergeStrategyExecutor`, `NonEmptyPropertyMergeStrategyExecutor` per graphify
Community 18), and `childPropertyTypes` for nesting. `PropertyType`s are themselves
`META-INF/cxs/properties/*.json` declarations, loaded the same bundle-lifecycle way as
condition/action/rule/segment types (see "Extensibility model" below) — properties are an
extension point, not a fixed schema.

## The conditions DSL — the flagship artifact

A `Condition` (`api/src/main/java/org/apache/unomi/api/conditions/Condition.java`) is
minimal by design: a `conditionTypeId` (or resolved `ConditionType` reference) plus a flat
`Map<String,Object> parameterValues` — no dedicated AST node types per operator. Nesting is
achieved by putting `Condition` objects *inside* another condition's parameter map (e.g.
`booleanCondition`'s `subConditions` parameter is a `List<Condition>`). `deepCopy()` has
explicit cycle detection (`IdentityHashMap`, throws `IllegalStateException` on a cyclic
condition graph) and `toYaml()` has an explicit `maxDepth` guard — both defensive against a
condition tree that self-references or nests too deep, which matters once conditions can
reference other stored conditions via `parentCondition`.

**A `ConditionType` (`api/src/main/java/org/apache/unomi/api/conditions/ConditionType.java`)
declares two independent, separately-pluggable interpretations of the same tree**: a
`conditionEvaluator` id (resolved through `ConditionEvaluatorDispatcher` for in-memory boolean
evaluation) and a `queryBuilder` id (resolved through
`ConditionOSQueryBuilderDispatcher`/`ConditionESQueryBuilder` equivalent for translating to a
search-engine query). This is the core insight: **the same declarative condition data can be
asked two different questions** — "does this one loaded item match?" (rule/action triggering,
`ConditionEvaluatorDispatcherImpl.eval`,
`persistence-spi/src/main/java/org/apache/unomi/persistence/spi/conditions/evaluator/impl/
ConditionEvaluatorDispatcherImpl.java:106-229`) versus "which stored items match, without
loading them?" (segment computation, REST query endpoints,
`ConditionOSQueryBuilderDispatcher.buildFilter`,
`persistence-opensearch/core/src/main/java/org/apache/unomi/persistence/opensearch/
ConditionOSQueryBuilderDispatcher.java:102-176`). Both dispatchers resolve
`condition.getConditionType() == null` via the same `TypeResolutionService` and both walk a
`parentCondition` chain to support "inherited"/templated conditions
(`ParserHelper.resolveEffectiveCondition`).

**Condition-type taxonomy** (core, in `plugins/baseplugin/.../conditions/` +
`persistence-{elasticsearch,opensearch}/.../querybuilders/core/`, confirmed by reading both the
evaluator and the query-builder side of each):

| Condition type | Evaluator | Query builder | Shape |
|---|---|---|---|
| `booleanCondition` | `BooleanConditionEvaluator` | `BooleanConditionESQueryBuilder`/`OSQueryBuilder` | AND/OR over a `List<Condition> subConditions` — short-circuits |
| `propertyCondition` | `PropertyConditionEvaluator` | `PropertyConditionESQueryBuilder`/`OSQueryBuilder` | `propertyName` + `comparisonOperator` + one of 5 parallel typed value params (see below) |
| `sourceEventPropertyCondition` | `SourceEventPropertyConditionEvaluator` | `SourceEventPropertyConditionESQueryBuilder`/`OSQueryBuilder` | property condition scoped to the triggering event's source, not the profile |
| `notCondition` | `NotConditionEvaluator` | `NotConditionESQueryBuilder`/`OSQueryBuilder` | negates one sub-condition |
| `matchAllCondition` | `MatchAllConditionEvaluator` | `MatchAllConditionESQueryBuilder`/`OSQueryBuilder` | trivially true / match-all query |
| `idsCondition` | `IdsConditionEvaluator` | `IdsConditionESQueryBuilder`/`OSQueryBuilder` | explicit id-list membership |
| `nestedCondition` | `NestedConditionEvaluator` | `NestedConditionESQueryBuilder`/`OSQueryBuilder` | evaluates a sub-condition against a nested object path (e.g. an item inside a list property) |
| `geoLocationByPointSessionCondition` | `GeoLocationByPointSessionConditionEvaluator` | `GeoLocationByPointSessionConditionESQueryBuilder`/`OSQueryBuilder` | geo-distance test |
| `pastEventCondition` (advanced) | `PastEventConditionEvaluator` | `PastEventConditionESQueryBuilder`/`OSQueryBuilder` | "has event X occurred N times in the past" — see below |

**`propertyCondition`'s comparison-operator set is the single richest artifact in the repo**
(read from both `PropertyConditionEvaluator.isMatch`,
`plugins/baseplugin/.../PropertyConditionEvaluator.java:288-486`, and
`PropertyConditionOSQueryBuilder.buildQuery`, which independently reimplement the same 20
operators): `equals`, `notEquals`, `greaterThan`, `greaterThanOrEqualTo`, `lessThan`,
`lessThanOrEqualTo`, `between`, `exists`, `missing`, `contains`, `notContains`, `startsWith`,
`endsWith`, `matchesRegex`, `in`, `notIn`, `all`, `inContains`, `hasSomeOf`, `hasNoneOf`,
`isDay`, `isNotDay`, `distance` — 22 operators covering scalar comparison, string matching,
set membership, day-granularity date equality, and geo-distance, over five parallel value
"slots" (`propertyValue[/s]`, `propertyValue[/s]Integer`, `...Double`, `...Date`,
`...DateExpr`) instead of one tagged value.

**This parallel-typed-value encoding is also the direct cause of the repo's #1 complexity
hotspot.** `PropertyConditionEvaluator.isMatch` is cognitive-complexity **651** (verified by
reading the full 199-line method,
`plugins/baseplugin/src/main/java/org/apache/unomi/plugins/baseplugin/conditions/
PropertyConditionEvaluator.java:288-486`) — a 61-branch `if`/`else-if` chain that exists purely
to figure out, per branch, *which* of the five nullable value slots is populated and coerce
types accordingly, before even reaching the actual comparison. **Reimplementation note:** a
single tagged `{type: 'string'|'int'|'double'|'date'|'dateExpr', value}` field collapses this
entire complexity class to a `switch` on `type` follwed by a `switch` on operator — this is a
straightforward, high-value fix that upstream Unomi itself has not made in 940 files of
evolution, and a port should not reproduce the mistake.

## Segments and scoring

`SegmentService` (`api/src/main/java/org/apache/unomi/api/services/SegmentService.java`)
handles **both** `Segment` and `Scoring` — they share one implementation,
`SegmentServiceImpl extends AbstractMultiTypeCachingService`
(`services/src/main/java/org/apache/unomi/services/impl/segments/SegmentServiceImpl.java`), and
both are just a `Condition` (or, for `Scoring`, a weighted list of condition+value
`ScoringElement`s) plus metadata. `setSegmentDefinition` (cognitive 45, complexity 19, 94
lines) validates the condition tree (`ConditionValidationService`), persists it, and — the
important bit — can trigger `updateAutoGeneratedRules`/`updateExistingProfilesForSegment`
depending on config, i.e. **segment-definition changes can eagerly recompute membership rather
than waiting for the next matching event.**

**Membership is denormalized onto the profile, not computed on read**:
`isProfileInSegment(Profile, segmentId)` (cognitive 6) just checks
`profile.getSegments().contains(segmentId)` — an O(1) set-membership check against a value
maintained elsewhere, not a live condition evaluation. The two update paths:

1. **Realtime, event-driven:** a segment's underlying condition is (re-)evaluated against a
   profile as a side effect of event processing — `EvaluateProfileSegmentsAction` (graphify
   Community 101) is a rule **action** that, when attached to a rule, re-runs segment matching
   for the profile that just triggered an event and updates `profile.segments` in place before
   the profile is saved. This is push-based and per-profile, not a scan.
2. **Batch/scheduled, config-driven:** `SegmentServiceImpl` carries `segmentUpdateBatchSize`
   (default 1000), `segmentRefreshInterval`, `maximumIdsQueryCount`,
   `dailyDateExprEvaluationHourUtc` (default 5 — a fixed UTC hour for re-evaluating
   date-expression-relative segment conditions, e.g. "joined more than 30 days ago", which
   drift with wall-clock time even without a new event), and `batchSegmentProfileUpdate` — a
   scheduled task (`ScheduledTask`, `SchedulerServiceImpl`) sweeps and bulk-recomputes segment
   membership for the whole profile population on this cadence, using the query-builder side of
   the same `Condition` to find candidates without loading them one at a time.

**Past-event conditions use a third, incremental-counter strategy that is neither pure realtime
nor pure batch.** `pastEventCondition` (e.g. "visited product page ≥3 times in 30 days") has a
**precomputed fast path**: `SetEventOccurenceCountAction`
(`plugins/baseplugin/src/main/java/org/apache/unomi/plugins/baseplugin/actions/
SetEventOccurenceCountAction.java:163-185`) is a rule action that increments a named counter in
`profile.systemProperties.get("pastEvents")` (a `List<Map<String,Object>>` of `{key, count}`)
**inline, as part of normal event processing** — no separate batch job. `PastEventCondition-
Evaluator.eval` (`plugins/advanced-conditions/src/main/java/org/apache/unomi/plugins/
advancedconditions/conditions/PastEventConditionEvaluator.java:66-102`) then reads that
precomputed counter in O(1) if `generatedPropertyKey` is set, falling back to a live
`persistenceService.queryCount` against the event index otherwise (marked `TODO` for
deprecation — "each past event condition should have a generatedPropertyKey"). This is a
materialized-counter pattern, not a scheduled recompute: the cost of "how many times has X
happened" is paid once per matching event, not once per condition check or once per batch run.

**What happens when a segment definition changes:** `setSegmentDefinition` re-validates and
persists the new condition immediately; whether existing profile memberships are eagerly
recomputed or left to drift until the next event/scheduled sweep is a config choice
(`updateExistingProfilesForSegment`-style behavior gated by the same batch-size/refresh-interval
settings above) — there is no unconditional "recompute everyone now" guarantee, and a large
population with a large `segmentUpdateBatchSize` window can see stale membership after a
definition edit until the sweep catches up.

## Rules and actions

`RulesServiceImpl implements EventListenerService` — it is one of the listeners
`EventServiceImpl.sendInternal` calls on every event (see ingestion trace above).
`onEvent(Event)` (cognitive 7) does loop/dedup bookkeeping via a `ThreadLocal ProcessingContext`
(`processingEvents`/`reportedLoops` sets, keyed by an event fingerprint) before delegating to
`processEvent`. **`getMatchingRules(Event)`** (cognitive 76, the rules-engine hot path) resolves
candidate rules per-tenant from a cache keyed by event type
(`rulesByEventTypeByTenant: Map<tenantId, Map<eventType, Set<Rule>>>`), with a fallback merge of
tenant-specific rules, "all event types" rules, and system-tenant rules — `optimizedRulesActivated`
gates whether this indexed-by-event-type lookup is used versus a full scan.

A matching `Rule`'s `condition` is evaluated via the same `ConditionEvaluatorDispatcher`
described above, and on a match its `actions: List<Action>` are executed in order through
**`ActionExecutorDispatcherImpl.execute(Action, Event)`**
(`services/src/main/java/org/apache/unomi/services/actions/impl/ActionExecutorDispatcherImpl.java`).
The dispatcher resolves the action's `actionExecutor` key, and if it contains a `:` (e.g.
`groovy:someScript`), routes to a registered `ActionDispatcher` by prefix
(`GroovyActionDispatcher` is the only one in-tree) instead of a direct `ActionExecutor` —
**two extension mechanisms for the same concept**, one for native Java, one for scripted/
non-Java runtimes. Contextual parameters (`ParserHelper.hasContextualParameter`, a
`"script"` value-extractor wired into `ActionExecutorDispatcherImpl`'s constructor) let an
action's parameter values be computed from the triggering event at execution time rather than
being static. Every eval/execute call is wrapped in a `MetricAdapter` timer
(`metricsService`) and an optional `RequestTracer` span — the tracing infrastructure
(`tracing-api`) is threaded through condition evaluation, query building, and action execution
uniformly, which is a clean cross-cutting pattern independent of the OSGi substrate.

## Extensibility model

Three genuinely distinct registration mechanisms, all converging on the same `PluginType`
abstraction (`ConditionType`/`ActionType` both extend `MetadataItem implements PluginType`,
carrying a `pluginId` = the contributing OSGi bundle's id):

1. **Native Java, imperative:** implement `ConditionEvaluator`/`ActionExecutor`/
   `ConditionOSQueryBuilder` as a plain class, register it as an OSGi
   `@Component(service = ConditionEvaluator.class, property =
   {"conditionEvaluatorId=..."})` (see `PastEventConditionEvaluator`). The dispatcher's
   `bindEvaluator`/`bindExecutor` methods (OSGi declarative-services callbacks) add it to a
   `ConcurrentHashMap` keyed by that id — fully dynamic, survives bundle install/uninstall at
   runtime.
2. **Declarative JSON manifest, no code:** drop a `ConditionType`/`ActionType`/`PropertyType`/
   `Rule`/`Segment`/`Scoring` JSON document under `META-INF/cxs/<type>/*.json` inside *any*
   bundle. `AbstractMultiTypeCachingService` (`services-common/src/main/java/org/apache/unomi/
   services/common/cache/AbstractMultiTypeCachingService.java`, the shared base class of
   `DefinitionsServiceImpl`, `RulesServiceImpl`, `SegmentServiceImpl`) implements
   `SynchronousBundleListener` itself and reacts to `BundleEvent.STARTED`/`STOPPING`
   (`bundleChanged`, cognitive 5) by calling `loadPredefinedItemsForType`
   (cognitive 74), which walks `bundle.findEntries(metaInfPath)`, deserializes each JSON file
   via Jackson, and tags the resulting object's `pluginId` with the bundle's id — so uninstalling
   the bundle can cleanly retract everything it contributed (`pluginContributions`/`pluginTypes`
   maps keyed by bundle id). **This "drop a manifest file in a well-known path, get it
   auto-registered and auto-retracted on unload" convention is the single most portable idea
   in this section** — it needs no OSGi specifically, only *some* notion of a
   loadable/unloadable extension unit (a directory, a plugin package, a feature flag) and a
   file-watch or install/uninstall hook.
3. **Dynamically compiled scripts, no bundle rebuild:** `GroovyActionsServiceImpl`
   additionally loads `*.groovy` files from the same `META-INF/cxs/actions/` convention,
   compiling them at runtime via `GroovyShell`/`GroovyScriptEngine` and dispatching to them
   through the `GroovyActionDispatcher` prefix mechanism described above — the lowest-friction
   extension tier, since it needs neither a new OSGi bundle nor a JVM restart.

## Consent and privacy

`Consent` (`api/src/main/java/org/apache/unomi/api/Consent.java`) is a plain value object:
`scope` + `typeIdentifier` (externally-defined, Unomi has no built-in vocabulary of consent
types) + `ConsentStatus` (`GRANTED`/`DENIED`/`REVOKED`) + `statusDate`/`revokeDate`, with
`isConsentGrantedAtDate(Date)` doing the actual time-windowed check (granted only if
`statusDate` has passed and, if set, `revokeDate` has not). Consents live in a
`Map<String,Consent>` on `Profile`, keyed by (scope, type) — a profile can hold many
independent consents simultaneously (e.g. "newsletter: granted", "tracking: denied").

**Consent is not enforced by a dedicated gate — it is enforced by the same generic condition/
accessor mechanism as everything else.** There is no `PrivacyService.checkConsent()`-style call
in the ingestion path; instead:

- **Mutation** happens through the ordinary rule/action pipeline —
  `ModifyConsentAction.execute` (`plugins/baseplugin/src/main/java/org/apache/unomi/plugins/
  baseplugin/actions/ModifyConsentAction.java`) reads a `consent` map off the triggering
  event's properties, builds a `Consent`, and calls `profile.setConsent(consent)`, returning
  `EventService.PROFILE_UPDATED` only if something actually changed (idempotent re-application
  of the same consent is a no-op). This means "grant/revoke consent" is just another event type
  a client sends to `/context.json` — no separate consent API surface.
- **Querying/filtering by consent** goes through `ConsentAccessor`
  (`plugins/baseplugin/src/main/java/org/apache/unomi/plugins/baseplugin/conditions/accessors/
  ConsentAccessor.java`), one of a family of `HardcodedPropertyAccessor`s (graphify Community
  83: `ConsentAccessor`, `EventAccessor`, `ProfileAccessor`, `RuleAccessor`, …) that expose an
  object's fields as dotted property paths for the generic `propertyCondition`/nested-condition
  machinery — so "profiles who denied consent type X" is just a `propertyCondition` over
  `consents.X.status`, not a bespoke consent-segment type. **Consent reuses the conditions DSL
  rather than growing its own query language** — a real instance of the extensibility model
  paying for itself, and a strong argument that a port's consent model should be "just another
  filterable property," not a separate subsystem.
- **Anonymous browsing** (`PrivacyService.isRequireAnonymousBrowsing`/`getAnonymousProfile`) is
  the other privacy lever exercised in the traced ingestion path (see above) — a profile-level
  preference that swaps in a shadow anonymized profile for the session without deleting the
  real one, and `getFilteredEventTypes` lets a profile opt out of specific event types being
  recorded at all (checked in `RestServiceUtilsImpl.performEventsRequest` before the event ever
  reaches persistence).

This is a real, working, standards-adjacent design — consent is a first-class value on the
profile, it composes with the same condition language everything else uses, and mutation is
auditable through the normal event stream. It is not, however, a deep compliance
implementation: there is no built-in consent-type registry/vocabulary, no double opt-in
workflow, and no automatic enforcement that denies event *collection* itself based on a consent
status (that would need to be built as rule logic on top, e.g. a `notCondition` guard on a
tracking rule) — Unomi gives you the pieces, not a GDPR/CCPA policy engine.

## Data model / persistence engine

Two **fully independent, non-shared** backend implementations exist side by side —
`persistence-elasticsearch` and `persistence-opensearch` — each with its own full copy of the
condition-query-builder taxonomy (`querybuilders/core/*ESQueryBuilder.java` vs
`*OSQueryBuilder.java`, one file per condition type, near-identical logic against two different
client libraries). `PersistenceService` (`persistence-spi`) is the shared interface (`save`,
`query`, `queryCount`, `aggregateQuery`, …); `InMemoryPersistenceServiceImpl` (a third,
test-only implementation used across the unit-test suite) is graphify's #9 god node (208 edges)
purely from being the thing every service test wires up.

Index/mapping shape is declared as versioned JSON under `META-INF/cxs/mappings/*.json` per
item type (`profile.json`, `event.json`, `session.json`, …) — `profile.json:57-59` is where the
`pastEvents` system property's structure is declared, confirming it as a first-class indexed
field, not an ad-hoc blob. `loadPredefinedMappings`/`loadPainlessScripts`
(both ES and OS variants, each ~25 lines, near-duplicated) bootstrap the index templates and
scripted aggregations (`resetScoringPlan`, `evaluateScoringPlanElement` — Painless scripts for
recomputing `Scoring` values inside the search engine itself, avoiding a round-trip per
profile) on startup. `aggregateQuery` is the #2 complexity hotspot in the repo (cognitive 176,
duplicated near-identically between the ES and OS impls) — the cost of maintaining two backends
is paid again here, not just in the query builders.

**What this reveals about access patterns:** the two backends being genuinely parallel (not one
wrapping the other) means Unomi's persistence abstraction is a *shape* contract
(`PersistenceService`'s method signatures), not a shared query-compilation layer — every
condition type's query logic is written twice. A port targeting a single store (Postgres) would
not reproduce this: one `Condition → SQL WHERE` compiler, not two.

## What's good

- **The condition/query dual-dispatch design is genuinely elegant** and the strongest single
  idea in the 12-repo survey so far for a segment/rule engine: one declarative data shape,
  two independently pluggable interpreters (evaluate vs. compile-to-query), selected per
  `ConditionType` via two separate string ids.
- **No import cycles** (graphify, confirmed) despite 46 Maven modules and an OSGi bundle graph —
  the module boundaries are real, not aspirational.
- **The three-tier extensibility model** (Java component / JSON manifest / Groovy script) scales
  contribution effort to the complexity of the extension, and the manifest tier's auto-register/
  auto-retract-on-bundle-lifecycle behavior is a clean pattern independent of OSGi specifically.
- **Consent composes with the general condition language** instead of growing a parallel query
  mechanism — the accessor-registry pattern (`HardcodedPropertyAccessor` family) is a legitimate
  extensibility point most CDPs bolt on ad hoc.
- **Uniform cross-cutting tracing and metrics**: every condition eval, query build, and action
  execution is wrapped in the same `RequestTracer`/`MetricAdapter` pattern, not sprinkled
  inconsistently.
- **Real integration-test discipline for a JVM project of this age**: 60 `*IT.java` files
  running against a live Karaf container (Pax Exam), covering security
  (`SecurityIT`, `V2CompatibilityModeIT`), input validation (`InputValidationIT`), migrations
  (`Migrate16xToCurrentVersionIT`, `Migrate121`/`122`), and GraphQL (a dozen `GraphQL*IT`
  classes) — this is not a repo coasting on unit tests alone.

## What's weak

### 1. Two fully-duplicated persistence backends double the maintenance and complexity surface
Every condition type's query-building logic, every index-mapping loader, and the #2 complexity
hotspot (`aggregateQuery`, cognitive 176) exist twice — once for Elasticsearch, once for
OpenSearch — with no shared compilation layer between them. This is the direct cause of a large
fraction of the repo's total line count and duplicated hotspots. A port to one store avoids this
entirely, but should not copy the "write it once per backend" habit if more than one datastore
is ever supported.

### 2. The parameter-typing choice in `propertyCondition` produces the worst complexity hotspot
in the repo by construction, not by accident
Five parallel nullable value fields (`propertyValue`, `...Integer`, `...Double`, `...Date`,
`...DateExpr`) instead of one tagged value force a 61-branch, cognitive-651 method
(`PropertyConditionEvaluator.isMatch`) just to figure out which slot is populated before any
actual comparison happens. This is fixable with a tagged-value encoding and should not be
carried into a reimplementation.

### 3. The ingestion path has no transactional envelope
`sendInternal`'s event-persist and `finalizeEventsRequest`'s profile/session-persist are
separate, sequential, non-transactional writes to the search engine. A crash between them loses
consistency between what was recorded as "happened" and what the profile/session reflect — there
is no outbox, no idempotency key visible on the write path, and no compensating recovery logic
in the traced flow. Fine for a personalization cache; not something to copy for a system where
profile state must reconcile with a durable event log.

### 4. This exact commit is a live rearchitecture in progress, not a stable target to clone
behavior from
The multi-tenant/API-key auth layer, the `V2CompatibilityMode` shim, and the coexistence of an
old fully-open ingestion model with a new gated one all point to an in-flight migration. Several
`TODO`s are visible in the traced code (`PastEventConditionEvaluator.java:86`: "should not
happen anymore, each past event condition should have a generatedPropertyKey";
`PropertyType.java:72,83`: "TODO: deprecated?" on `target`). Treat every "how it works" claim in
this document as commit-`b1b73db8`-specific.

### 5. Rule/segment recomputation freshness is a config knob, not a guarantee
Nothing in `SegmentServiceImpl` enforces "membership is always eventually consistent within N
seconds" — `segmentRefreshInterval`, `segmentUpdateBatchSize`, and
`dailyDateExprEvaluationHourUtc` are independently tunable, and a definition change's effect on
existing profiles depends on which of the realtime-action-triggered, scheduled-batch, or
date-expression-daily-sweep paths next touches a given profile. A port needs an explicit,
documented consistency model here rather than three independently configurable staleness knobs.

## Two-tool cross-check (cbm-mcp vs graphify)

cbm: 26,274 nodes / 96,566 edges (moderate mode, includes Bash/YAML/Groovy). graphify: 12,767
nodes / 48,381 edges (code + prose docs), 459 communities, 181 thin omitted, 85%
EXTRACTED/15% INFERRED/0% AMBIGUOUS.

- **Agree:** `Condition`, `Event`, `Profile`, `Item` are the core abstractions — cbm fan-in
  (`Item.getItemId` 440, `Condition.setParameter` 167, `Condition.setConditionTypeId` 139) and
  graphify god-nodes (`Condition` 817 edges, `Event` 361, `Profile` 358, `Item` 238) independently
  converge on the same ranking, with `Condition` as the single largest hub in the codebase by
  both measures — a strong, doubly-confirmed signal that the condition model is the true center
  of this system, not the profile store the project's marketing copy emphasizes.
- **cbm added:** per-function `cognitive`/`transitive_loop_depth` (confirmed non-zero and
  meaningful on Java — see Section 0 #4), 12+ Leiden clusters via `get_architecture`, and (mostly
  unusable, see Section 0 #5) `Route` nodes.
- **graphify added:** import-cycle detection (**zero**, confirmed) and a portable, committed
  `GRAPH_REPORT.md` — though its community list needed manual filtering of markdown-heading
  noise (Section 0 #7) before being useful as an architecture map.
- **Both engines' outputs were corroborating, not contradictory**, on every claim checked —
  unlike Chatwoot (name-collision noise) and Mautic (`composer.json` pollution), this repo gave
  clean signal from both tools with only the two noise modes documented in Section 0.

### Tool calibration notes (carry into the remaining repos)

1. **cbm loop/cognitive metrics: confirmed non-zero on Java, a third language data point.**
   Ruby (Chatwoot): all-zero. TypeScript (Dittofeed): populated. Java (Unomi): populated
   (2,207/8,520 functions non-zero cognitive, 2,704 non-zero transitive_loop_depth). The
   per-language-not-per-repo hypothesis now has three confirmations — keep verifying explicitly
   per language rather than assuming from one prior repo.
2. **cbm `Route` extraction quality is per-annotation-style, not just per-framework.** JAX-RS
   `@Path`/`@GET` annotations on a class extract correctly when present (4/4 accurate), but a
   codebase that registers most endpoints via OSGi service properties instead of a uniformly
   scanned annotation surface will have most of its real endpoints invisible to the `Route`
   extractor regardless of framework support — check the *registration mechanism*, not just
   "does this framework use JAX-RS."
3. **A `Route`-labeled node can silently be non-HTTP data.** ~70 of this repo's 102 `Route` nodes
   are Kafka consumer config keys (`broker: "kafka"`), not paths — always inspect the `method`/
   `route_path`/`source`/`broker` fields on a sample before trusting a `Route` count as "N HTTP
   endpoints."
4. **cbm hotspot fan-in name-collision risk is real even in a codebase where the top hits are
   genuine** — `getItemId`/`setItemId` (both unique) sit in the same list as `get` (38
   definitions) and `getConditionType` (7). Verify per-symbol via
   `MATCH (m) WHERE m.name = 'X' RETURN count(m)`, every time, regardless of how the repo's other
   top hits checked out.
5. **graphify community detection can absorb markdown numbered-list headings as graph "nodes"**
   when prose docs are committed alongside code and use numbered structure — a new noise mode,
   distinct from the manifest-key god-node pollution seen on Chatwoot/Mautic. It did not affect
   the god-node ranking here, but would mislead a reader skimming communities as a module map.
6. **`ORDER BY toInteger(f.field)` is still silently ignored; `WHERE toInteger(f.field) > 0`
   still errors** (`unexpected operator at pos N`) — reconfirmed on this repo. Filter on the raw
   string (`f.field <> '0'`) in `WHERE`, project with `toInteger()` only in `RETURN`/`ORDER BY`
   on the aliased column.
7. **Cost/time:** cbm moderate index ≈ 1 min for 848 Java + support files, 9 dirs auto-excluded.
   graphify ≈ 6 min (1,500 files, 906,956 words — the largest corpus in the survey so far),
   $0 LLM. Both cheap enough to run on every repo in the set.

## Reimplementation notes (per section: port / adapt / skip)

| Section | Verdict | Why |
|---|---|---|
| HTTP/API surface (tenant + API-key auth) | **Skip** | JVM/Karaf/JAAS-specific; the *shape* (public-key vs. private-key vs. admin tiers) is ordinary and needs no Unomi-specific reference |
| Event ingestion pipeline | **Adapt** | The synchronous load-or-create-profile/session → run listeners → conditionally persist shape is sound and portable; add the durability envelope Unomi lacks (Section "What's weak" #3) rather than copying it as-is |
| Profile/session model | **Adapt** | Flat properties + denormalized segments/scores on the profile is a reasonable starting shape; skip the `mergedWith`-deprecated-in-favor-of-aliases historical baggage and design alias merge in from day one |
| **Conditions DSL** | **Port closely (concept), rewrite (code)** | The declarative-tree-with-dual-interpreter design is the highest-value idea in this repo; port the condition-type taxonomy and the evaluator/query-builder split as a pattern, write a single SQL compiler instead of Unomi's two search-engine compilers, and use a tagged value type to avoid the `isMatch` complexity trap |
| Segments/scoring | **Adapt** | The three-tier freshness model (realtime action, scheduled batch, incremental counter for past-events) is worth the read, but needs one coherent consistency guarantee, not three independently configurable knobs |
| Rules/actions | **Port the pattern** | Event listener → matching-rule lookup → ordered action execution, with a prefix-based dispatch escape hatch for non-native action runtimes, is a clean, minimal engine worth copying structurally |
| Extensibility model | **Port the pattern, not OSGi** | The manifest-drop-and-bundle-lifecycle-auto-register convention is the second-highest-value idea here; implement it with a plugin-package/feature-flag-scoped load/unload instead of OSGi bundles |
| Consent/privacy | **Port the pattern** | "Consent is a filterable property via the generic condition language, mutated via the generic action pipeline" is a strong, replicable design; do not build a bespoke consent query mechanism |
| Data model/persistence | **Skip the duplication, keep the contract** | Keep `PersistenceService`'s method-shape contract (save/query/queryCount/aggregateQuery) as an interface; write one query compiler for Postgres, not one per potential backend |

## Port targets for Open Marketing (ranked)

1. **The condition-type taxonomy + dual evaluator/query-builder dispatch** — the single
   highest-value artifact in the repo. Port the taxonomy (boolean/property/not/matchAll/ids/
   nested/geo/pastEvent + the 22 property operators) and the two-interpreter-per-type pattern;
   write our own SQL compiler.
2. **The manifest-based extensibility convention** (drop a declarative file, get auto-register/
   auto-retract on load/unload) — reimplement without OSGi, e.g. a `plugins/<name>/manifest.json`
   convention read at plugin-package install/uninstall time.
3. **The consent-as-filterable-property + action-mutated-consent pattern** — pairs naturally
   with the condition DSL port; avoids building a parallel consent query language.
4. **The past-event materialized-counter pattern** (`SetEventOccurenceCountAction` +
   `generatedPropertyKey`) — a cheap, general technique for "how many times has X happened"
   without a live aggregation query, applicable well beyond Unomi's specific use.
5. **The rule → matching-lookup → ordered-action-execution engine shape**, including the
   prefix-based dispatcher escape hatch for non-native action runtimes (our equivalent of
   "groovy:" could be "webhook:" or "workflow:").
6. **The `PersistenceService` method-shape contract** (save/query/queryCount/aggregateQuery/
   bulk) as an interface to design our own Postgres-backed store against — not the two backend
   implementations themselves.

**Skip:** both search-engine persistence implementations wholesale (write one Postgres compiler
instead of porting either); the OSGi/Karaf/JAAS runtime substrate entirely; the GraphQL CDP
schema layer (useful as a read of what a standards body considers table-stakes, not as code to
lift); the multi-tenant API-key auth layer (ordinary shape, JVM-specific implementation); the
Camel-based `router` extension and the `salesforce-connector`/`geonames`/`weather-update`
extensions (single-vendor or narrow-utility, not marketing-automation-relevant).

**Do not expect from this repo:** a journey/sequence builder, a campaign or broadcast engine, an
email-sending or deliverability pipeline, or any send-time/scheduling logic — Unomi is a
profile-and-event store with a rich query/rule layer bolted on, not a marketing-automation
platform. Source those from Dittofeed (journeys, segments-at-scale) and Mautic (campaign UI,
lead scoring) when reconciling this survey with the others.

## Reproducing / refreshing this analysis

- **graphify** (installed CLI, `$0`, no LLM):
  `cd /Users/la/Programming/OSS-Marketing-Repos/unomi && graphify update .`
  → refreshes `graphify-out/{graph.json, GRAPH_REPORT.md, manifest.json}` (~6 min on this repo,
  1,500 files). **Do not pass `--no-viz` to `update`** — it is not a valid option there and exits
  2; `update` auto-skips the HTML visualization above 5,000 nodes regardless.
- **codebase-memory-mcp:** project `unomi`, indexed 2026-09-06 in `moderate` mode at commit
  `b1b73db8` (26,274 nodes / 96,566 edges, 9 dirs auto-excluded). Use `get_architecture`,
  `search_graph`, `search_code`, `get_code_snippet`, `query_graph`.
  **`ORDER BY`/`WHERE` trap (reconfirmed a third time):** numeric node properties are stored as
  strings. `WHERE f.cognitive <> '0'` works as a string comparison; `WHERE toInteger(f.cognitive)
  > 0` errors (`unexpected operator at pos N`). `RETURN toInteger(f.cognitive) AS cog ... ORDER
  BY cog DESC` sorts correctly; `... ORDER BY toInteger(f.cognitive) DESC` is silently ignored
  and returns insertion order.
