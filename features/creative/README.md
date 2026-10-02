# creative

Public entry: `@open-marketing/creative` only. Build on **@jini-ai/integrations/media-providers**, pinned to published 0.3.6. Core imports public types only. Runtime vendor adapters, dispatch engines, signers and credentials remain in `content/agent-plugins` and are supplied through caller-owned ports.

Reuse Jini `AsyncOperationStore`, `AsyncOperationRecord`, `startOperation`, `pollDueOperations` and `recoverAfterRestart`. The durable async operation path preserves provider handles across restarts; `MediaTaskStore` intentionally interrupts synchronous tasks on restart and is not the resumable operation store.

OM adds safety-bound requests/quotes, operation/approval identities, append-only cost observations, generation provenance and media links. Requests include model/surface/seed and both deadline and attempt bounds. Receipts track the async operation ID and permit inline completion or pending work. Services/capability ports include bounded worker polling, recovery and local cancellation. Byte and guarded URL outputs enter media through `CreativeAssetPort`; cost/provenance records survive absent or delayed assets. Cancellation stops local scheduling and must not imply a refund or successful vendor cancellation. Unknown outcomes must reconcile before any non-idempotent resubmit.

`createCreativeService` remains inert; every service and double operation returns typed `not_implemented`. Safety owns allowance authority and dispatch-time rechecks. Jobs owns the single outbox and worker scheduling, independent of studio/agent sessions.

B1 absence scaffolds cover all caller-owned methods; j14 adds actual shared behavior/adapter suites and the acceptance listed in development/JOBS.md.
