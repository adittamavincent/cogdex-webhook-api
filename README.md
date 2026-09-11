# Cogdex App

Next.js 16 webhook backend for a Notion-native workspace. Notion buttons trigger typed actions, this app reads/writes Notion pages, materializes a canonical Memorandum, exports `<cogdex>` XML context packages, captures repository snapshots with Repomix, and restores project-scoped database views.

No user-facing product UI beyond a tiny status page. No auth system beyond webhook secret validation. No database other than Notion. Single-user personal tool.

---

## What It Actually Does

Buttons in Notion send webhooks to the Cogdex API, configured with a custom header representing the action/page type.

### Notion Page Types & Acronyms
- **CHAT**: Regular chat/session
- **MEMO**: Memorandum pipeline
- **USER**: User input
- **RESP**: Response
- **EXPO**: Export
- **CMNT**: Comment
- **UPDT**: Update
- **SYST**: System
- **TASK**: Task automation/execution
- **REPO**: Repository snapshot/state

### Mental Model

- **Entries DB** holds chronological event history: chat turns, exports, responses, snapshots, links.
- **Memorandum DB** holds one materialized latest memo per project.
- **`MEMO EXPO` is outbound-only**: it exists to dump a prompt/context package to an external LLM.
- **`MEMO RESP` is inbound canonical memo history**: the first `MEMO RESP` must be a full document, later `MEMO RESP` entries can be unified diffs.
- **`MEMO UPDT` replays `MEMO RESP` only** in chronological order to rebuild latest memorandum state.
- **Exports prefer the live Memorandum page**; replaying `MEMO RESP` is only fallback when that page is missing/empty.

### Actions

| Webhook Action / Custom Header | Triggered From | Behavior |
|---|---|---|
| `CHAT USER` / `CHAT RESP` / `MEMO EXPO` / `MEMO RESP` / `CHAT EXPO` / `CHAT CMNT` / `TASK EXPO` / `TASK RESP` / `REPO SNAP` / `CHAT LINK` | **Project Page** | Creates a new entry page in the **Entry** database linked to the project, or reuses the most recent empty entry of the same type. |
| `MEMO RESP` | **Entry Page** | Reclassifies/updates the current entry as `MEMO RESP`. The content is whatever was pasted into that entry; no automatic memo reconstruction happens here. |
| `MEMO UPDT` | **Project Page** | Gathers all `MEMO RESP` entries for the project, sorts them chronologically, requires the first one to be a full document, applies later diffs with the app's `applyPatch()` algorithm, then writes the materialized result to a single Memorandum page (archiving duplicates) and links the Project to it. |
| `MEMO EXPO` | **Project Page** (As exporting endpoint) | Builds a memorandum-oriented export package for an external LLM. This is outbound context only and is not used to reconstruct the Memorandum later. |
| `CHAT EXPO` | **Project Page** (As exporting endpoint) | Gathers `Include=true` context entries + included system prompts + latest live Memorandum. Exports a `<cogdex>` XML block and writes it to a `CHAT EXPO` entry. |
| `TASK EXPO` | **Project Page** (As exporting endpoint) | Same as `CHAT EXPO`, but also includes the latest repository snapshot and switches protocol instructions to task-execution mode. |
| `REPO SNAP` | **Project Page** | Reads `REPO URL` from the Project row, downloads the GitHub codebase, compiles structure using repomix, and writes output as paragraphs of code blocks to a new `REPO SNAP` entry. |
| `CHAT CMNT` | **Project/Entry Page** | Copies comments from previous entry, links references between two most recent entries. |
| `CHAT LINK` | **Project/Entry Page** | Resolves a Notion URL from `CHAT URL`, links the current entry to the target Entry/Memorandum/Project, and clones target page blocks into the current entry. |
| `CLEAR CHECKBOX` | **Project Page** | Unchecks `Include` on every Entry in the current project. |
| `REF INCLUDE` | **Entry Page** | Reads the row's `Entries Referenced` relation and snapshots project `Include` flags so only referenced entries remain checked. If relation is empty, nothing is changed. |
| `SYST LINK` | **Project Page** | Wipes current Project page blocks. Clones Entry, System Prompt, and Memorandum database views inside it based on template views, filtered to current Project. |

### Memorandum Rules

- First `MEMO RESP` in a project must be full markdown text, not a diff.
- Later `MEMO RESP` entries may be unified diffs wrapped in fenced `diff` blocks.
- `MEMO EXPO` is never used as input to `MEMO UPDT`.
- Latest Memorandum page is treated as canonical ground truth for exports when available.

---

## Notion Database Schemas

To sync properly with the codebase, configure these four databases in Notion:

### 1. Project Database
- `Name` (Title)
- `Memorandum` (Relation → Memorandum DB, single select/limit to 1 page)
- `CHAT URL` (URL or Rich Text, optional) — used by `CHAT LINK`
- `REPO URL` (URL or Rich Text) — source repository used by `REPO SNAP`

### 2. Entry Database
- `Name` (Title) — Stores the incremented entry number (e.g. `1`, `2`, `3`).
- `Type` (Select) — Values: `CHAT USER`, `CHAT RESP`, `MEMO EXPO`, `MEMO RESP`, `CHAT EXPO`, `CHAT CMNT`, `SYST LINK`, `MEMO UPDT`, `REPO SNAP`, `TASK EXPO`, `TASK RESP`, `CHAT LINK`.
- `Include` (Checkbox) — Set to `true` to include an entry in chat/task context exports. Export/system/snapshot/task/memo-maintenance entry types are auto-unchecked by the app.
- `Project` (Relation → Project DB)
- `Entries Referenced` (Relation → Entry DB)
- `Entries Referenced` can drive the `REF INCLUDE` action to snapshot which entries should stay included.
- `System Prompt Used` (Relation → System Prompt DB)
- `URL` / `CHAT URL` / similar link field (optional) — useful for `CHAT LINK`

### 3. Memorandum Database
- `Name` (Title) — Holds latest chronological entry number.
- `Project` (Relation → Project DB)

### 4. System Prompt Database
- `Name` (Title)
- `Include` (Checkbox) — Set to `true` to include in context exports.
- `Priority` (Number) — Sorting order for XML context blocks.

---

## Tech Stack

- **Runtime**: Node.js (latest LTS)
- **Framework**: Next.js 16 (App Router)
- **Package manager**: pnpm
- **Language**: TypeScript (strict)
- **Hosting**: Vercel
- **Notion SDK**: `@notionhq/client` v5 (uses `dataSources` and `views` API)
- **Notion API Version**: `2026-03-11`

> **Note on Notion SDK v5:** `notion.databases.query()` is now `notion.dataSources.query({ data_source_id })` and `pages.create` uses `parent: { data_source_id }` instead of `parent: { database_id }`.

---

## Project Structure

```
cogdex-webhook-api/
├── app/
│   ├── api/
│   │   └── cogdex/
│   │       └── webhook/
│   │           └── route.ts       ← webhook endpoint
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx                   ← status page
├── lib/
│   ├── notion.ts                  ← Notion client singleton
│   ├── entries.ts                 ← entry generation, diff patch, and views setup
│   ├── export.ts                  ← XML context export logic
│   ├── logger.ts                  ← logger utility
│   └── types.ts                   ← TS types
├── vercel.json                    ← maxDuration config
├── .env.local                     ← local configuration
└── package.json
```

---

## Environment Variables

Create `.env.local`:

```env
NOTION_TOKEN=secret_xxxxxxxxxxxx
COGDEX_WEBHOOK_SECRET=pick_a_long_random_string_here

# Databases (IDs are 32-char hex strings)
NOTION_ENTRY_DB_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_SYSTEM_PROMPT_DB_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_MEMORANDUM_DB_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_BRANCH_DB_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Templates for View Cloning
NOTION_ENTRY_VIEW_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_SYSTEM_PROMPT_VIEW_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_MEMORANDUM_VIEW_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Optional: customize incoming headers
COGDEX_SECRET_HEADER=x-cogdex-secret
COGDEX_PAGE_TYPE_HEADER=x-cogdex-page-type
```

Set the same variables in Vercel.

---

## Webhook API

**Endpoint:** `POST /api/cogdex/webhook`

**Headers:**

| Header | Value | Purpose |
|---|---|---|
| `x-cogdex-secret` or `cogdex-secret` | your secret | authentication |
| `x-cogdex-page-type` or `cogdex-page-type` | `CHAT USER` / `CHAT RESP` / `MEMO EXPO` / `MEMO RESP` / `CHAT EXPO` / `CHAT CMNT` / `CLEAR CHECKBOX` / `REF INCLUDE` / `SYST LINK` / `MEMO UPDT` / `REPO SNAP` / `TASK EXPO` / `TASK RESP` / `CHAT LINK` | action type |

The webhook also accepts the configured header names with or without the `x-` prefix. For auth it additionally accepts `Authorization: Bearer <secret>`.

**Body:** Notion sends page details automatically:
```json
{
  "source": { "automation_id": "...", "user_id": "...", "action_id": "..." },
  "data": {
    "object": "page",
    "id": "<Page ID>",
    "properties": {}
  }
}
```

---

## Deployment & Dev

```bash
# Verify build
pnpm build

# Deploy to Vercel
pnpm dlx vercel

# Run local dev server
pnpm dev
```
