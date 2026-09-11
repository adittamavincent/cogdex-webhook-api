# AGENTS.md

Repo-specific instructions for future coding agents working on `cogdex-webhook-api`.

## Core Truths

- Treat Notion as source of truth. This repo is webhook backend plus Notion compiler/mutator, not a traditional app with its own DB.
- Do not infer architecture from old assumptions. Check current code in `lib/entries.ts`, `lib/export.ts`, `app/api/cogdex/webhook/route.ts`, and `README.md` before changing webhook behavior.

## Memorandum Pipeline

- `MEMO EXPO` is outbound-only. It exists to dump context to an external LLM.
- `MEMO RESP` is inbound canonical memo history.
- `MEMO UPDT` must rebuild the Memorandum from `MEMO RESP` entries only, in chronological order.
- First `MEMO RESP` in a project must be full markdown, not a diff.
- Later `MEMO RESP` entries may be unified diffs.
- Do not use `MEMO EXPO` to reconstruct the Memorandum.
- Exports should prefer the live Memorandum page as ground truth; replay `MEMO RESP` only as fallback.

## Include Controls

- `CLEAR CHECKBOX` is a Project-level button/action. It is not an Entry-DB action button.
- `CLEAR CHECKBOX` unchecks `Include` for all entries in the current project.
- `REF INCLUDE` is an Entry-level button/action.
- `REF INCLUDE` reads the triggering row's `Entries Referenced` relation and snapshots `Include` so only referenced entries remain checked.
- If `Entries Referenced` is empty, `REF INCLUDE` must do nothing. Never clear all includes in that case.

## System Link Rules

- `SYST LINK` creates linked database views inside the Project page.
- When cloning the Entry linked database view, keep newer Entry action buttons visible even if the template predates them.
- Current required visible Entry action button: `Ref Include`.
- Do not assume Project-level buttons belong in the Entry linked database view.

## Repo Snapshot Rules

- `REPO SNAP` must read repository URL from Project DB property `REPO URL`.
- Do not fetch repo URL from Memorandum DB.

## Header Compatibility

- Webhook auth/page-type headers may arrive with `x-` prefix or without it.
- Auth also accepts `Authorization: Bearer <secret>`.
- Keep README and code aligned whenever accepted header aliases change.

## Editing Rules

- If you modify `.env` or `.env.local`, sync matching example/env docs too.
- Put disposable debug/test scripts in `scratch/`, not repo root.
- If you add new buttons or Notion properties, update both:
  - webhook/type handling in code
  - README schema/action documentation

## Before Shipping Changes

- Re-check that README still matches actual runtime behavior.
- Re-check button ownership:
  - Project DB buttons vs Entry DB buttons
  - linked database visibility rules
- Re-check memorandum assumptions; this repo already had bugs caused by mixing up `MEMO EXPO` and `MEMO RESP`.
