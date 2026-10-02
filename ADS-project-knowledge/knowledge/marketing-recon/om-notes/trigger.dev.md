# Open Marketing — notes on this clone

This repo was surveyed for the Open Marketing build. **This file is ours, not upstream's** —
it is untracked here and safe to delete.

- **Doc:** `../docs/trigger-dev-architecture.md`
- **Read first:** `../docs/capability-synthesis.md` (organized by capability, supersedes the
  per-repo docs for decision-making)
- **Plan:** `../docs/open-marketing-build-plan.md`
- **cbm index:** `trigger-dev` — already built, do **not** re-index

## Licence — YES

Apache-2.0 root; 14 packages explicitly `"license": "MIT"` (`core`, `cli-v3`, `trigger-sdk`,
`build`, `python`, `coordinator`, providers, `redis-worker`, …). No `ee/`, no licence-key gate
anywhere. Apache's patent grant/termination is the only practical difference from MIT here.

*Engineering reading of licence text, not legal advice.*

## What this repo was mined for

Studied as the *rejected* alternative for durable execution: it checkpoints the OS process, and
that mechanism needs CRIU via `crictl`/`buildah` or Docker's experimental checkpoint feature —
so the vendor's own self-hosting docs mark it **Cloud-only**. Everything is available; the
flagship capability is not usable.

Its `WorkerDeployment` staged-promotion model was examined for journey versioning and found to
solve it for *code*, not for a graph a person is standing in.
