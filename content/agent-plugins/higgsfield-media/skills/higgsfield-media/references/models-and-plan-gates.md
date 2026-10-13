# Models, plans and credits

Adapted from Tovu's Apache-2.0 same-path reference for OM, 2026-10-12.

`models_explore` historically supported model discovery, details and recommendations.
Use the currently admitted schema and account evidence; parameters can change.

On one Tovu account on 2026-09-09, `gpt_image_2` and `recraft_v4_1` were refused
with `Requires basic plan or higher`, while `z_image` submitted. These historical
examples are never current OM defaults or entitlements.

A historical `generate_image` preflight used `params.get_cost: true` and reported
`cost.credits_exact = 1.25` without submission. Successful pricing did not prove
plan entitlement. This binding quotes locally from reviewed evidence. A separate
preflight binding requires current approved non-spending acceptance evidence.

Credits are not currency. Only reviewed account/model/configuration/schema-bound
conversion evidence may produce money. Missing/mismatched/expired evidence yields
an unknown/expired quote, not a reusable zero-dollar bound.

`supports_unlim` historically described model support, while `unlim.available`
described account availability. Neither proves zero cost. This binding rejects
`use_unlim` and unreviewed flags.

Actual money requires explicit provider charge evidence. A quote, `cost.credits_exact`,
success, failure, timeout or cancellation alone does not prove the final charge.
The tests use a SYNTHETIC `charge` shape; verify a current provider schema before
production admission. Video, batches, billing and plan changes are deferred.
