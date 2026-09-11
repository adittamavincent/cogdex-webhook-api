import { notion } from "./notion";
import { PageType } from "./types";
import { debug, warn, error as logError } from "./logger";
import { readPageContent } from "./export";

const ENTRY_DB_ID = process.env.NOTION_ENTRY_DB_ID || process.env.NOTION_ENTRIES_DB_ID!;
const SYSTEM_PROMPT_DB_ID = process.env.NOTION_SYSTEM_PROMPT_DB_ID!;
const MEMORANDUM_DB_ID = process.env.NOTION_MEMORANDUM_DB_ID!;

const resolvedIds = new Map<string, string>();

export async function resolveDataSourceId(dbId: string): Promise<string> {
  if (!dbId) return dbId;
  if (resolvedIds.has(dbId)) return resolvedIds.get(dbId)!;
  try {
    const db = await notion.databases.retrieve({ database_id: dbId }) as any;
    if (db && db.data_sources && db.data_sources.length > 0) {
      const dsId = db.data_sources[0].id;
      resolvedIds.set(dbId, dsId);
      return dsId;
    }
  } catch (err) {
    // fallback
  }
  resolvedIds.set(dbId, dbId);
  return dbId;
}

interface NotionPage {
  id: string;
  properties?: Record<string, {
    checkbox?: boolean;
    number?: number | null;
    title?: Array<{ plain_text?: string }>;
    select?: { name?: string } | null;
    relation?: Array<{ id: string }>;
  }>;
  icon?: {
    type: "emoji" | "external" | "file";
    emoji?: string;
    external?: { url: string };
    file?: { url: string };
  } | null;
}

const EMOJIS = [
  "🌿", "🌸", "🍁", "🍄", "🌴", "🌵", "🌶️", "🍇", "🥑", "🍋",
  "⭐", "🔥", "⚡", "💧", "🌈", "🌊", "❄️", "🌀", "🔮", "💎",
  "🤖", "👾", "🚀", "🛸", "🦖", "🦊", "🐙", "🦉", "🦁", "🦄",
  "🎨", "🎭", "🎪", "🎸", "🎯", "🧩", "🎲", "🎬", "🎤", "🛹",
  "🧭", "🔭", "🕯️", "🔑", "🛡️", "🧬", "🧪", "⚙️", "🔋", "🔔"
];

// Page body templates per Type
const TEMPLATES: Record<PageType, string> = {
  "CHAT USER": "",
  "CHAT RESP": "",
  "MEMO EXPO": "",
  "MEMO RESP": "",
  "CHAT EXPO": "",
  "CHAT CMNT": "",
  "CLEAR CHECKBOX": "",
  "REF INCLUDE": "",
  "SYST LINK": "",
  "MEMO UPDT": "",
  "REPO SNAP": "",
  "TASK EXPO": "",
  "TASK RESP": "",
  "CHAT LINK": "",
};

export function findProperty(properties: Record<string, any>, name: string): any {
  const targetKey = name.toLowerCase().replace(/\s+/g, "");
  const matchedKey = Object.keys(properties).find(
    (k) => k.toLowerCase().replace(/\s+/g, "") === targetKey
  );
  return matchedKey ? properties[matchedKey] : null;
}

export async function getNextEntryNumber(projectId: string, excludeEntryId?: string): Promise<number> {
  const entryDbId = await resolveDataSourceId(ENTRY_DB_ID);
  const response = await notion.dataSources.query({
    data_source_id: entryDbId,
    filter: { property: "Project", relation: { contains: projectId } },
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: 30,
  });

  for (const entry of response.results) {
    if (excludeEntryId && entry.id === excludeEntryId) {
      continue;
    }
    const nameProp = findProperty((entry as any).properties || {}, "Name");
    const title = nameProp?.title?.[0]?.plain_text?.trim() ?? "";
    if (/^\d+$/.test(title)) {
      const num = parseInt(title, 10);
      if (!isNaN(num)) {
        return num + 1;
      }
    }
  }

  return 1;
}

export async function createEntry(params: {
  thoughtId: string;
  pageType: PageType;
  entriesReferencedIds?: string[];
  systemPromptsUsedIds?: string[];
}): Promise<{ pageId?: string; ignored?: boolean }> {
  const { thoughtId, pageType } = params;
  const isExport = pageType === "CHAT EXPO";

  const entryDbId = await resolveDataSourceId(ENTRY_DB_ID);

  const nextNumber = await getNextEntryNumber(thoughtId);

  const excludedFromInclude = new Set([
    "CHAT EXPO",
    "MEMO EXPO",
    "MEMO RESP",
    "REPO SNAP",
    "MEMO UPDT",
    "SYST LINK",
    "TASK EXPO",
    "TASK RESP"
  ]);

  const properties: Record<string, unknown> = {
    Name: { title: [{ text: { content: String(nextNumber) } }] },
    Type: { select: { name: pageType } },
    Include: { checkbox: !excludedFromInclude.has(pageType) },
    Project: { relation: [{ id: thoughtId }] },
  };

  if (params.entriesReferencedIds && params.entriesReferencedIds.length > 0) {
    properties["Entries Referenced"] = {
      relation: params.entriesReferencedIds.map((id) => ({ id })),
    };
  }

  if (params.systemPromptsUsedIds && params.systemPromptsUsedIds.length > 0) {
    properties["System Prompt Used"] = {
      relation: params.systemPromptsUsedIds.map((id) => ({ id })),
    };
  }

  const blocksToAppend = (!isExport && pageType !== "MEMO EXPO") ? markdownToNotionBlocks(TEMPLATES[pageType]) : [];

  const createPayload: any = {
    parent: { data_source_id: entryDbId },
    properties,
    children: blocksToAppend,
  };

  const page = await notion.pages.create(createPayload);
  return { pageId: page.id, ignored: false };
}

export async function updateExistingEntryProperties(params: {
  entryId: string;
  projectId: string;
  pageType: PageType;
  entriesReferencedIds?: string[];
  systemPromptsUsedIds?: string[];
  pageObj?: any;
}): Promise<void> {
  const { entryId, projectId, pageType } = params;
  const entryDbId = await resolveDataSourceId(ENTRY_DB_ID);

  const resolvedPageObj = (params.pageObj && params.pageObj.id === entryId)
    ? params.pageObj
    : (await notion.pages.retrieve({ page_id: entryId }));
  const currentNameProp = findProperty(resolvedPageObj.properties || {}, "Name");
  const currentName = currentNameProp?.title?.[0]?.plain_text ?? "";

  const excludedFromInclude = new Set([
    "CHAT EXPO",
    "MEMO EXPO",
    "MEMO RESP",
    "REPO SNAP",
    "MEMO UPDT",
    "SYST LINK",
    "TASK EXPO",
    "TASK RESP"
  ]);

  const properties: Record<string, unknown> = {
    Type: { select: { name: pageType } },
    Include: { checkbox: !excludedFromInclude.has(pageType) },
  };

  if (!/^\d+$/.test(currentName.trim())) {
    const nextNumber = await getNextEntryNumber(projectId, entryId);
    properties.Name = { title: [{ text: { content: String(nextNumber) } }] };
  }

  if (params.entriesReferencedIds && params.entriesReferencedIds.length > 0) {
    properties["Entries Referenced"] = {
      relation: params.entriesReferencedIds.map((id) => ({ id })),
    };
  }

  if (params.systemPromptsUsedIds && params.systemPromptsUsedIds.length > 0) {
    properties["System Prompt Used"] = {
      relation: params.systemPromptsUsedIds.map((id) => ({ id })),
    };
  }

  await notion.pages.update({
    page_id: entryId,
    properties: properties as any,
  });
}

export async function findRecentEmptyEntry(projectId: string, pageType: PageType): Promise<string | undefined> {
  const entryDbId = await resolveDataSourceId(ENTRY_DB_ID);
  const response = await notion.dataSources.query({
    data_source_id: entryDbId,
    filter: {
      and: [
        { property: "Project", relation: { contains: projectId } },
        { property: "Type", select: { equals: pageType } }
      ]
    },
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: 1
  });

  if (response.results.length === 0) return undefined;

  const latestEntry = response.results[0] as any;
  const nameProp = findProperty(latestEntry.properties || {}, "Name");
  const latestName = nameProp?.title?.[0]?.plain_text ?? "";

  if (!/^\d+$/.test(latestName.trim())) {
    return latestEntry.id;
  }

  return undefined;
}

// Minimal markdown-to-Notion-blocks converter for templates.
// Only handles headings (##) and paragraphs — intentionally minimal.
function markdownToNotionBlocks(md: string): Record<string, unknown>[] {
  const lines = md.split("\n");
  const blocks: Record<string, unknown>[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      blocks.push({
        object: "block",
        type: "heading_2",
        heading_2: {
          rich_text: [{ type: "text", text: { content: line.slice(3) } }],
        },
      });
    } else {
      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: line } }],
        },
      });
    }
  }

  return blocks;
}

export async function handleSystemLink(thoughtId: string): Promise<void> {
  debug(`Starting handleSystemLink for page ${thoughtId}`);

  // 1. Fetch original view configurations to clone sorting/ordering/formatting
  const ORIGINAL_ENTRY_VIEW_ID = process.env.NOTION_ENTRY_VIEW_ID;
  const ORIGINAL_SYSTEM_PROMPT_VIEW_ID = process.env.NOTION_SYSTEM_PROMPT_VIEW_ID;
  const ORIGINAL_MEMORANDUM_VIEW_ID = process.env.NOTION_MEMORANDUM_VIEW_ID;

  if (!ORIGINAL_ENTRY_VIEW_ID || !ORIGINAL_SYSTEM_PROMPT_VIEW_ID || !ORIGINAL_MEMORANDUM_VIEW_ID) {
    throw new Error(
      "Missing required view ID environment variables: NOTION_ENTRY_VIEW_ID, NOTION_SYSTEM_PROMPT_VIEW_ID, NOTION_MEMORANDUM_VIEW_ID"
    );
  }

  debug(`Fetching original views: Entry=${ORIGINAL_ENTRY_VIEW_ID}, SystemPrompt=${ORIGINAL_SYSTEM_PROMPT_VIEW_ID}, Memorandum=${ORIGINAL_MEMORANDUM_VIEW_ID}`);
  const [entryView, systemPromptView, memorandumView] = await Promise.all([
    notion.views.retrieve({ view_id: ORIGINAL_ENTRY_VIEW_ID }),
    notion.views.retrieve({ view_id: ORIGINAL_SYSTEM_PROMPT_VIEW_ID }),
    notion.views.retrieve({ view_id: ORIGINAL_MEMORANDUM_VIEW_ID }),
  ]);

  // 2. Wipe clean all blocks inside the current page
  try {
    await (notion.pages.update as any)({
      page_id: thoughtId,
      erase_content: true
    });
  } catch (err) {
    warn("Failed to use erase_content, falling back to manual block deletion", err);
    let hasMore = true;
    let startCursor: string | undefined = undefined;

    while (hasMore) {
      const listResponse = await notion.blocks.children.list({
        block_id: thoughtId,
        start_cursor: startCursor,
      });

      if (listResponse.results.length > 0) {
        await Promise.all(
          listResponse.results.map((block) =>
            notion.blocks.delete({ block_id: block.id }).catch(err => warn(`Failed to delete block ${block.id}:`, err))
          )
        );
      }

      hasMore = listResponse.has_more;
      startCursor = listResponse.next_cursor ?? undefined;
    }
  }
  debug("Wiped clean all blocks inside project page");

  // 3. (Branch logic removed)

  // 4. Helper to create view cloned from original
  const createClonedView = async (
    originalView: any,
    fallbackDataSourceId: string,
    modifyFilter?: (filter: any) => any
  ) => {
    const dataSourceId = originalView.data_source_id || fallbackDataSourceId;
    const name = originalView.name || "View";
    const type = originalView.type || "table";
    const sorts = originalView.sorts || undefined;
    let configuration = originalView.configuration ? JSON.parse(JSON.stringify(originalView.configuration)) : undefined;
    let dbProperties: any = {};
    try {
      debug(`Retrieving actual schema for data source ${dataSourceId} to sanitize property configurations`);
      const db = await notion.dataSources.retrieve({ data_source_id: dataSourceId }) as any;
      dbProperties = db.properties || {};
      const validPropertyIds = new Set(
        Object.values(db.properties).flatMap((prop: any) => [
          prop.id,
          decodeURIComponent(prop.id),
          encodeURIComponent(prop.id),
        ])
      );
      validPropertyIds.add("title");

      if (configuration && configuration.properties && Array.isArray(configuration.properties)) {
        configuration.properties = configuration.properties.filter((p: any) => {
          if (!p.property_id) return false;
          const decoded = decodeURIComponent(p.property_id);
          const encoded = encodeURIComponent(p.property_id);
          return (
            validPropertyIds.has(p.property_id) ||
            validPropertyIds.has(decoded) ||
            validPropertyIds.has(encoded)
          );
        });
        debug(`Sanitized properties list: kept ${configuration.properties.length} valid properties`);
      }
    } catch (schemaErr) {
      warn(`Could not retrieve schema for data source ${dataSourceId} to sanitize configuration:`, schemaErr);
    }

    if (!configuration) {
      configuration = { properties: [] };
    }
    if (!configuration.properties || !Array.isArray(configuration.properties)) {
      configuration.properties = [];
    }
    if (typeof configuration.frozen_column_index === "number" && configuration.frozen_column_index < 0) {
      delete configuration.frozen_column_index;
    }

    if (fallbackDataSourceId === MEMORANDUM_DB_ID) {
      const repoUrlKey = Object.keys(dbProperties).find(
        (key) => key.toLowerCase().trim() === "repo url"
      );
      if (repoUrlKey) {
        const repoUrlId = dbProperties[repoUrlKey].id;
        const repoUrlProp = configuration.properties.find(
          (p: any) => p.property_id === repoUrlId || (p.property_name && p.property_name.toLowerCase().trim() === "repo url")
        );
        if (repoUrlProp) {
          repoUrlProp.visible = true;
        } else {
          configuration.properties.push({
            property_id: repoUrlId,
            property_name: repoUrlKey,
            visible: true,
            width: 200
          });
        }
      }
    }

    let titleProp = configuration.properties.find((p: any) => p.property_id === "title");
    if (!titleProp) {
      titleProp = {
        property_id: "title",
        property_name: "Name",
        visible: true,
        width: 100
      };
      configuration.properties.push(titleProp);
    }

    const ensureVisibleProperty = (propertyNames: string[], width: number) => {
      for (const propertyName of propertyNames) {
        const dbPropKey = Object.keys(dbProperties).find(
          (key) => key.toLowerCase().trim() === propertyName.toLowerCase()
        );
        if (!dbPropKey) continue;

        const dbPropId = dbProperties[dbPropKey].id;
        const existingProp = configuration.properties.find(
          (p: any) =>
            p.property_id === dbPropId ||
            (p.property_name && p.property_name.toLowerCase().trim() === propertyName.toLowerCase())
        );

        if (existingProp) {
          existingProp.visible = true;
          existingProp.width = existingProp.width || width;
        } else {
          configuration.properties.push({
            property_id: dbPropId,
            property_name: dbPropKey,
            visible: true,
            width,
          });
        }
      }
    };

    if (fallbackDataSourceId === ENTRY_DB_ID) {
      // Keep Entry-DB action buttons visible even when the template view predates them.
      ensureVisibleProperty(["Ref Include"], 120);
    }

    for (const prop of configuration.properties) {
      const propId = prop.property_id;
      const propName = (prop.property_name || "").trim();
      const propNameLower = propName.toLowerCase();

      if (fallbackDataSourceId === ENTRY_DB_ID) {
        if (propId === "title" || propNameLower === "name") {
          prop.width = 125;
          prop.visible = true;
        } else if (propNameLower === "type") {
          prop.width = 125;
        } else if (propNameLower === "created time") {
          prop.visible = false;
        } else if (propNameLower === "project") {
          prop.visible = false;
        } else if (propNameLower === "entries referenced") {
          prop.width = 100;
        } else if (propNameLower === "related back to entry") {
          prop.width = 100;
        } else if (propNameLower === "system prompt used") {
          prop.width = 100;
        } else if (propNameLower === "include") {
          prop.width = 32;
        }
      } else if (fallbackDataSourceId === MEMORANDUM_DB_ID) {
        if (propId === "title" || propNameLower === "name") {
          prop.width = 100;
        } else if (propNameLower === "project") {
          prop.visible = false;
        } else if (propNameLower === "repo url") {
          prop.visible = true;
        }
      } else if (fallbackDataSourceId === SYSTEM_PROMPT_DB_ID) {
        if (propId === "title" || propNameLower === "name") {
          prop.width = 150;
        } else if (propNameLower === "include") {
          prop.width = 32;
        } else if (propNameLower === "priority") {
          prop.width = 100;
        } else if (propNameLower === "created time") {
          prop.visible = false;
        }
      }
    }

    let filter = originalView.filter || undefined;
    if (modifyFilter) {
      filter = modifyFilter(filter);
    }

    await notion.views.create({
      data_source_id: dataSourceId,
      name,
      type,
      create_database: {
        parent: {
          type: "page_id",
          page_id: thoughtId,
        },
      },
      filter,
      sorts,
      configuration,
    } as any);
  };

  // Modifier to enforce scoping to current project
  const projectFilterModifier = (origFilter: any) => {
    const projectFilter = {
      property: "Project",
      relation: {
        contains: thoughtId,
      },
    };
    if (!origFilter) {
      return projectFilter;
    }
    return {
      and: [
        projectFilter,
        origFilter,
      ],
    };
  };

  // 5. Create the cloned views sequentially

  debug("Creating cloned Memorandum database view");
  await createClonedView(memorandumView, MEMORANDUM_DB_ID, projectFilterModifier);

  debug("Creating cloned Entry database view");
  await createClonedView(entryView, ENTRY_DB_ID, projectFilterModifier);

  debug("Creating cloned System Prompt database view");
  await createClonedView(systemPromptView, SYSTEM_PROMPT_DB_ID);

  debug(`Successfully finished handleSystemLink for page ${thoughtId}`);
}

export function isDiff(content: string): boolean {
  return /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/m.test(content);
}

interface Hunk {
  oldStart: number;
  oldLength: number;
  newStart: number;
  newLength: number;
  lines: string[];
}

export function unwrapCodeFences(text: string): string {
  let trimmed = text.trim();
  
  const fenceCount = (trimmed.match(/^`{3,}/gm) || []).length;
  if (fenceCount === 1) {
    throw new Error("Diff is truncated (unclosed code fence).");
  }
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    trimmed = trimmed.slice(1, -1).trim();
  }

  // 0. Fast-path: if the text already starts with a raw @@ hunk header it has
  //    already been unwrapped (e.g. by a prior call to this function or by the
  //    test harness). Return immediately to avoid mis-detecting ``` context lines
  //    inside the diff as code-fence delimiters.
  if (/^@@\s+-\d+/.test(trimmed)) {
    return trimmed;
  }

  // 1. If the entire string is a code fence, unwrap it.
  const exactMatch = trimmed.match(/^`{3,}(?:[a-zA-Z0-9_-]+)?\r?\n([\s\S]*?)\r?\n`{3,}$/);
  if (exactMatch) {
    return exactMatch[1];
  }

  // 2. If the text contains a diff inside a code block, extract it — then also collect any
  //    raw @@ hunk blocks that appear OUTSIDE the fence (common LLM output pattern where the
  //    model emits extra hunks as prose after closing the ```diff fence).
  const partialMatch = trimmed.match(/`{3,}(?:[a-zA-Z0-9_-]+)?\r?\n([\s\S]*?)\r?\n`{3,}/);
  if (partialMatch && isDiff(partialMatch[1])) {
    const fencedDiff = partialMatch[1];
    // Collect raw @@ hunks that appear after the code fence closes.
    const afterFence = trimmed.slice(partialMatch.index! + partialMatch[0].length);
    const extraHunks = extractRawHunkBlocks(afterFence);
    if (extraHunks.length > 0) {
      return fencedDiff + "\n" + extraHunks.join("\n");
    }
    return fencedDiff;
  }

  // 3. If the whole text (no fence) contains raw @@ hunks, return as-is so parseDiff can handle it.
  if (isDiff(trimmed)) {
    return trimmed;
  }

  // 4. Otherwise return the original text (preserves full documents containing code blocks).
  return trimmed;
}

/**
 * Extract raw @@ hunk blocks from prose text (text that is NOT inside a code fence).
 * LLMs sometimes emit hunks as plain text after closing a ```diff block.
 * Returns an array of raw hunk text strings (each starting with @@).
 *
 * IMPORTANT: code fences that appear INSIDE an active hunk are kept as part of
 * the hunk (they are diff context lines), not treated as fence boundaries.
 */
function extractRawHunkBlocks(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const result: string[] = [];
  let current: string[] | null = null;
  let inCodeFence = false;
  let fenceChar = "";

  for (const line of lines) {
    const trimmedLine = line.trim();

    // Track code fences, but only when we are NOT inside an active hunk.
    // Inside a hunk the fence is diff context (e.g. an ENV variable block).
    const fenceMatch = trimmedLine.match(/^(`{3,})/);
    if (fenceMatch && current === null) {
      // Outside a hunk — fence is a literal code example, skip its contents.
      if (!inCodeFence) {
        inCodeFence = true;
        fenceChar = fenceMatch[1];
      } else if (trimmedLine.startsWith(fenceChar)) {
        inCodeFence = false;
        fenceChar = "";
      }
      continue;
    }

    if (inCodeFence && current === null) continue;

    const hunkHeader = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/);
    if (hunkHeader) {
      if (current !== null) {
        result.push(current.join("\n"));
      }
      current = [line];
    } else if (current !== null) {
      current.push(line);
    }
  }

  if (current !== null && current.length > 0) {
    result.push(current.join("\n"));
  }

  return result;
}

/**
 * Normalise a single raw diff line that an LLM may have garbled.
 *
 * LLMs commonly produce these malformed patterns (checked before the
 * standard prefix guard so they are caught first):
 *   "  +content"      — leading whitespace then `+`  → addition
 *   "- +content"      — markdown list-bullet then `+` → addition
 *   "## +content"     — heading marker then `+`      → addition
 *
 * Lines that already carry an unambiguous standard prefix (+/-/space/\)
 * and do NOT match a compound pattern are returned unchanged.
 */
function normalizeDiffLine(line: string): string {
  if (line === "" || line.startsWith("\\")) return line;

  // "  +content" or "\t+content" — leading whitespace then `+` (must check BEFORE early return)
  const indentedAdd = line.match(/^[ \t]+(\+.*)$/);
  if (indentedAdd) return indentedAdd[1];

  // "- +content" or "* +content" — markdown list bullet, then `+`
  const bulletAdd = line.match(/^[-*]\s+(\+.*)$/);
  if (bulletAdd) return bulletAdd[1];

  // "## +content", "### +content", etc. — heading marker then `+`
  const headingAdd = line.match(/^#{1,6}\s*(\+.*)$/);
  if (headingAdd) return headingAdd[1];

  // Already has a valid diff prefix — return as-is.
  if (/^[+\- ]/.test(line)) return line;

  return line;
}

export function parseDiff(diffText: string): Hunk[] {
  const content = unwrapCodeFences(diffText);
  const lines = content.split(/\r?\n/);
  const hunks: Hunk[] = [];

  // ── Two-pass approach ────────────────────────────────────────────────────
  // Pass 1: split raw lines into per-hunk buckets (with header metadata).
  // Pass 2: normalize each line and apply the removal-budget guard using the
  //         *pre-computed* expected removal count so we don't misclassify
  //         markdown list items (which start with "- ") as diff removals.

  interface RawHunk {
    oldStart: number;
    oldLength: number;
    newStart: number;
    newLength: number;
    rawLines: string[];
  }

  const rawHunks: RawHunk[] = [];
  let currentRaw: RawHunk | null = null;

  for (const line of lines) {
    const m = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (m) {
      if (currentRaw) {
        // Trim trailing blank lines
        while (currentRaw.rawLines.length > 0 && currentRaw.rawLines[currentRaw.rawLines.length - 1].trim() === "") {
          currentRaw.rawLines.pop();
        }
        rawHunks.push(currentRaw);
      }
      currentRaw = {
        oldStart:  parseInt(m[1], 10),
        oldLength: m[2] ? parseInt(m[2], 10) : 1,
        newStart:  parseInt(m[3], 10),
        newLength: m[4] ? parseInt(m[4], 10) : 1,
        rawLines: [],
      };
    } else if (currentRaw) {
      currentRaw.rawLines.push(line);
    }
  }
  if (currentRaw) {
    while (currentRaw.rawLines.length > 0 && currentRaw.rawLines[currentRaw.rawLines.length - 1].trim() === "") {
      currentRaw.rawLines.pop();
    }
    rawHunks.push(currentRaw);
  }

  // Pass 2: normalize lines and build the final Hunk objects.
  for (const raw of rawHunks) {
    // Pre-count addition lines in the raw hunk to compute expectedRemovals.
    const additionsCount = raw.rawLines.filter(l => {
      const n = normalizeDiffLine(l);
      return n.startsWith("+");
    }).length;
    // expected_removals = max(0, oldLength - newLength + additions)
    // Context-promotion of "- list item" lines (treating them as context rather than
    // removals) is applied ONLY when the hunk is clearly net-additive: newLength >= 1.5x
    // oldLength. For hunks with similar sizes the "-" prefix is more likely a genuine
    // removal and we trust it as such.
    const rawExpected = raw.oldLength - raw.newLength + additionsCount;
    const isNetAdditive = raw.oldLength > 0 && (raw.newLength / raw.oldLength) >= 1.5;
    const expectedRemovals = (rawExpected <= 0 && isNetAdditive) ? 0 : Math.max(0, rawExpected);

    const hunk: Hunk = {
      oldStart:  raw.oldStart,
      oldLength: raw.oldLength,
      newStart:  raw.newStart,
      newLength: raw.newLength,
      lines: [],
    };

    for (const line of raw.rawLines) {
      const normalized = normalizeDiffLine(line);
      if (normalized.startsWith("+") || normalized.startsWith("-") || normalized.startsWith(" ") || normalized === "" || normalized.startsWith("\\")) {
        // Guard: a "-" line that looks like a markdown list item ("- text") is
        // ambiguous. Demote it to a context line once the removal budget is
        // exhausted (budget = expectedRemovals, not oldLength).
        if (normalized.startsWith("-") && /^-\s+\S/.test(normalized)) {
          const removalsUsed = hunk.lines.filter(l => l.startsWith("-")).length;
          if (removalsUsed >= expectedRemovals) {
            // Budget exhausted — treat as context.
            hunk.lines.push(" " + normalized.slice(1));
            continue;
          }
        }
        hunk.lines.push(normalized);
      } else {
        if (!line.startsWith("diff ") && !line.startsWith("--- ") && !line.startsWith("+++ ")) {
          hunk.lines.push(" " + line);
        }
      }
    }

    // Trim trailing blank lines
    while (hunk.lines.length > 0 && hunk.lines[hunk.lines.length - 1].trim() === "") {
      hunk.lines.pop();
    }
    hunks.push(hunk);
  }

  return hunks;
}



// Code fence lines — must be handled transparently when LLMs omit them from diff context.
// They are skipped when matching prose lines and re-emitted in the output unchanged.
export function isCodeFenceLine(trimmed: string): boolean {
  return /^`{3,}/.test(trimmed);
}

// Structural lines that require EXACT match when they appear in the diff context.
// These lines must not be fuzzy-normalized since their normalized form is ambiguous.
function isExactMatchStructural(trimmed: string): boolean {
  // Code fence: ``` or ```lang
  if (/^`{3,}/.test(trimmed)) return true;
  // Horizontal rule / front-matter divider (only pure --- *** ___ patterns)
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) return true;
  // Table separator row: | --- | --- |
  if (/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(trimmed)) return true;
  return false;
}

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/^[-*+]\s+/, "")   // remove list bullet indicators at the start
    .replace(/[*_~`#]/g, "")    // remove markdown characters
    .trim()
    .replace(/\s+/g, " ");      // collapse spaces
}

// ── Structural Block Parser ─────────────────────────────────────────────────
// Parses markdown into structural blocks where tables and code blocks are
// atomic units. This prevents line-based diffing from fragmenting tables
// and code blocks across block boundaries.

interface StructuralBlock {
  kind: "heading" | "paragraph" | "table" | "code" | "divider" | "blank";
  content: string;       // raw markdown content (full table, full code block, etc.)
  startLine: number;     // 0-indexed start line in the original markdown
  endLine: number;       // 0-indexed exclusive end line
  headingLevel?: number; // 1-6 for heading blocks
}

/**
 * Parse markdown into structural blocks. Tables and code blocks are treated
 * as atomic units — all their lines belong to a single block.
 */
function parseStructuralBlocks(markdown: string): StructuralBlock[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: StructuralBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Blank line
    if (trimmed === "") {
      blocks.push({ kind: "blank", content: "", startLine: i, endLine: i + 1 });
      i++;
      continue;
    }

    // Code block (fenced)
    const codeStartMatch = trimmed.match(/^(`{3,})(.*)$/);
    if (codeStartMatch) {
      const fence = codeStartMatch[1];
      const fenceLen = fence.length;
      const startLine = i;
      i++; // skip opening fence
      while (i < lines.length) {
        const closeMatch = lines[i].trim().match(/^(`{3,})/);
        if (closeMatch && closeMatch[1].length >= fenceLen) {
          i++; // skip closing fence
          break;
        }
        i++;
      }
      blocks.push({
        kind: "code",
        content: lines.slice(startLine, i).join("\n"),
        startLine,
        endLine: i,
      });
      continue;
    }

    // Table (line starting and ending with |)
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      const startLine = i;
      while (i < lines.length && lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|")) {
        i++;
      }
      blocks.push({
        kind: "table",
        content: lines.slice(startLine, i).join("\n"),
        startLine,
        endLine: i,
      });
      continue;
    }

    // Heading
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      blocks.push({
        kind: "heading",
        content: line,
        startLine: i,
        endLine: i + 1,
        headingLevel: headingMatch[1].length,
      });
      i++;
      continue;
    }

    // Divider
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ kind: "divider", content: line, startLine: i, endLine: i + 1 });
      i++;
      continue;
    }

    // Regular paragraph / list / quote / etc.
    blocks.push({ kind: "paragraph", content: line, startLine: i, endLine: i + 1 });
    i++;
  }

  return blocks;
}

/**
 * Convert structural blocks back to text lines with type annotations.
 * Tables and code blocks emit their full content as a single logical unit
 * (but still as individual lines for the output format).
 */
function buildBlockLines(blocks: StructuralBlock[]): Array<{ text: string, type: "normal" | "added" }> {
  const result: Array<{ text: string, type: "normal" | "added" }> = [];
  for (const block of blocks) {
    const blockLines = block.content.split(/\r?\n/);
    for (const line of blockLines) {
      result.push({ text: line, type: "normal" });
    }
  }
  return result;
}

function superNormalize(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function matchLinesRelaxed(
  baseLines: Array<{ text: string, type: "normal" | "added" }>,
  baseIdx: number,
  searchLines: string[]
): { matchedLength: number, mapping: number[], mappingCounts: number[] } | null {
  let b = baseIdx;
  let s = 0;
  const mapping: number[] = new Array(searchLines.length).fill(-1);
  const mappingCounts: number[] = new Array(searchLines.length).fill(0);

  while (s < searchLines.length) {
    const sLine = searchLines[s].trim();

    if (sLine === "") {
      // Blank search line: advance past a single blank base line if present.
      // Never skip past non-blank base lines.
      if (b < baseLines.length && baseLines[b].text.trim() === "") {
        b++;
      }
      s++;
      continue;
    }

    // For structural search lines that require exact match (fences, dividers,
    // table separators): skip blank base lines, then require exact trimmed match.
    if (isExactMatchStructural(sLine)) {
      while (b < baseLines.length && baseLines[b].text.trim() === "") {
        b++;
      }
      if (b >= baseLines.length) return null;
      const bLine = baseLines[b].text.trim();
      if (bLine !== sLine) return null;
      mapping[s] = b;
      mappingCounts[s] = 1;
      b++;
      s++;
      continue;
    }

    // For normal prose lines: skip blank base lines, code fence lines, AND
    // horizontal divider lines (---) that LLMs frequently omit from diff context.
    // Also skip heading lines (e.g. ## Repository) if they don't match the current search line.
    // These skipped base lines are preserved in the output via the reconstruction loop.
    while (b < baseLines.length) {
      const bTrimmed = baseLines[b].text.trim();
      if (bTrimmed === "" || isCodeFenceLine(bTrimmed) || /^(-{3,}|\*{3,}|_{3,})$/.test(bTrimmed) || /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(bTrimmed)) {
        b++;
      } else if (/^#{1,6}\s+/.test(bTrimmed)) {
        if (normalizeText(bTrimmed) !== normalizeText(sLine)) {
          b++;
        } else {
          break;
        }
      } else {
        break;
      }
    }

    if (b >= baseLines.length) {
      return null;
    }

    const bLine = baseLines[b].text.trim();
    if (normalizeText(bLine) === normalizeText(sLine)) {
      mapping[s] = b;
      mappingCounts[s] = 1;
      b++;
      s++;
      continue;
    }

    // Try concatenation match for squashed lines (e.g. flattened tables)
    const normS = superNormalize(sLine);
    if (normS.length > 0) {
      let tempB = b;
      let concatenatedNorm = "";
      let matchedCount = 0;
      let found = false;

      for (let count = 1; count <= 15; count++) {
        if (tempB >= baseLines.length) break;
        const bText = baseLines[tempB].text.trim();
        concatenatedNorm += superNormalize(bText);
        tempB++;

        if (concatenatedNorm === normS) {
          matchedCount = count;
          found = true;
          break;
        }
        if (concatenatedNorm.length > normS.length) {
          break;
        }
      }

      if (found && matchedCount > 0) {
        mapping[s] = b;
        mappingCounts[s] = matchedCount;
        b += matchedCount;
        s++;
        continue;
      }
    }

    return null;
  }

  return { matchedLength: b - baseIdx, mapping, mappingCounts };
}

export function applyPatch(baseText: string, patchText: string): Array<{ text: string, type: "normal" | "added" }> {
  debug(`[applyPatch] Starting patch application on baseText length ${baseText.length}`);
  const hunks = parseDiff(patchText);
  debug(`[applyPatch] Parsed ${hunks.length} hunks from patchText`);
  let workingText = baseText;
  const baseLines: Array<{ text: string, type: "normal" | "added" }> = workingText.split(/\r?\n/).map(t => ({ text: t, type: "normal" as const }));
  if (hunks.length === 0) {
    debug(`[applyPatch] No hunks found, returning baseLines`);
    return baseLines;
  }

  const sortedHunks = [...hunks].sort((a, b) => b.oldStart - a.oldStart);

  for (const hunk of sortedHunks) {
    const searchLines: string[] = [];
    interface Op { type: "normal" | "added" | "removed", text: string, searchIdx?: number }
    const ops: Op[] = [];

    for (const line of hunk.lines) {
      if (line.startsWith("-")) {
        searchLines.push(line.slice(1));
        ops.push({ type: "removed", text: line.slice(1), searchIdx: searchLines.length - 1 });
      } else if (line.startsWith("+")) {
        ops.push({ type: "added", text: line.slice(1) });
      } else if (line.startsWith(" ")) {
        searchLines.push(line.slice(1));
        ops.push({ type: "normal", text: line.slice(1), searchIdx: searchLines.length - 1 });
      } else if (line.startsWith("\\")) {
        // Ignore
      } else {
        searchLines.push(line);
        ops.push({ type: "normal", text: line, searchIdx: searchLines.length - 1 });
      }
    }

    // Table-aware matching removed. Defer to line-level matching.

    // ── Standard line-level matching ─────────────────────────────────────
    const hintIndex = Math.max(0, hunk.oldStart - 1);
    let foundIndex = -1;
    let matchedLength = 0;
    let foundMapping: number[] | null = null;
    let foundMappingCounts: number[] | null = null;
    const maxOffset = Math.max(baseLines.length, 100);

    for (let offset = 0; offset < maxOffset; offset++) {
      const idxForward = hintIndex + offset;
      if (idxForward < baseLines.length) {
        const matchResult = matchLinesRelaxed(baseLines, idxForward, searchLines);
        if (matchResult) {
          foundIndex = idxForward;
          matchedLength = matchResult.matchedLength;
          foundMapping = matchResult.mapping;
          foundMappingCounts = matchResult.mappingCounts;
          break;
        }
      }
      const idxBackward = hintIndex - offset;
      if (offset > 0 && idxBackward >= 0) {
        const matchResult = matchLinesRelaxed(baseLines, idxBackward, searchLines);
        if (matchResult) {
          foundIndex = idxBackward;
          matchedLength = matchResult.matchedLength;
          foundMapping = matchResult.mapping;
          foundMappingCounts = matchResult.mappingCounts;
          break;
        }
      }
    }

    if (foundIndex === -1) {
      let startTrim = 0;
      while (startTrim < searchLines.length && ops.find(o => o.searchIdx === startTrim)?.type === "normal" && searchLines[startTrim].trim() === "") {
        startTrim++;
      }
      let endTrim = 0;
      while (endTrim < searchLines.length && ops.find(o => o.searchIdx === searchLines.length - 1 - endTrim)?.type === "normal" && searchLines[searchLines.length - 1 - endTrim].trim() === "") {
        endTrim++;
      }

      const trimmedSearch = searchLines.slice(startTrim, searchLines.length - endTrim);

      if (trimmedSearch.length > 0) {
        for (let offset = 0; offset < maxOffset; offset++) {
          const idxForward = hintIndex + offset;
          if (idxForward < baseLines.length) {
            const matchResult = matchLinesRelaxed(baseLines, idxForward, trimmedSearch);
            if (matchResult) {
              foundIndex = idxForward;
              matchedLength = matchResult.matchedLength;
              foundMapping = new Array(searchLines.length).fill(-1);
              foundMappingCounts = new Array(searchLines.length).fill(0);
              for (let i = 0; i < matchResult.mapping.length; i++) {
                foundMapping[startTrim + i] = matchResult.mapping[i];
                foundMappingCounts[startTrim + i] = matchResult.mappingCounts[i];
              }
              break;
            }
          }
          const idxBackward = hintIndex - offset;
          if (offset > 0 && idxBackward >= 0) {
            const matchResult = matchLinesRelaxed(baseLines, idxBackward, trimmedSearch);
            if (matchResult) {
              foundIndex = idxBackward;
              matchedLength = matchResult.matchedLength;
              foundMapping = new Array(searchLines.length).fill(-1);
              foundMappingCounts = new Array(searchLines.length).fill(0);
              for (let i = 0; i < matchResult.mapping.length; i++) {
                foundMapping[startTrim + i] = matchResult.mapping[i];
                foundMappingCounts[startTrim + i] = matchResult.mappingCounts[i];
              }
              break;
            }
          }
        }
      }
    }

    // Fallback: Flattened Relaxed Matching
    if (foundIndex === -1) {
      const searchFlat = superNormalize(searchLines.join(""));

      if (searchFlat.length > 10) {
        for (let start = 0; start < baseLines.length; start++) {
          let currentFlat = "";
          let end = start;

          while (end < baseLines.length && currentFlat.length < searchFlat.length) {
            currentFlat += superNormalize(baseLines[end].text);
            end++;
          }

          if (currentFlat === searchFlat) {
            foundIndex = start;
            matchedLength = end - start;

            // Build a fallback mapping for the matched range
            const fallbackMapping = new Array(searchLines.length).fill(-1);
            const fallbackMappingCounts = new Array(searchLines.length).fill(0);
            let baseIdx = foundIndex;
            for (let s = 0; s < searchLines.length; s++) {
              const sLine = searchLines[s].trim();
              if (sLine === "") continue;

              let foundB = -1;
              for (let b = baseIdx; b < foundIndex + matchedLength; b++) {
                const bLine = baseLines[b].text.trim();
                if (normalizeText(bLine) === normalizeText(sLine) || superNormalize(bLine) === superNormalize(sLine)) {
                  foundB = b;
                  break;
                }
              }

              if (foundB !== -1) {
                fallbackMapping[s] = foundB;
                fallbackMappingCounts[s] = 1;
                baseIdx = foundB + 1;
              }
            }
            foundMapping = fallbackMapping;
            foundMappingCounts = fallbackMappingCounts;
            break;
          }
        }
      }
    }

    // Fallback 2: Fuzzy Sequential Matching
    if (foundIndex === -1) {
      let bestScore = 0;
      let bestIdx = -1;
      let bestMatchedLength = 0;
      let bestMapping: number[] = [];
      let bestMappingCounts: number[] = [];

      for (let i = 0; i < baseLines.length; i++) {
        let score = 0;
        let b = i;
        const mapping = new Array(searchLines.length).fill(-1);
        const mappingCounts = new Array(searchLines.length).fill(0);

        for (let s = 0; s < searchLines.length; s++) {
          const sLine = searchLines[s];
          const sNorm = superNormalize(sLine);
          if (sNorm === "") continue;

          let found = false;
          for (let lookahead = 0; lookahead < 10; lookahead++) {
            if (b + lookahead >= baseLines.length) break;
            const bNorm = superNormalize(baseLines[b + lookahead].text);
            const isMatch = bNorm === sNorm || (sNorm.length > 5 && bNorm.length > 5 && (sNorm.includes(bNorm) || bNorm.includes(sNorm)));
            if (isMatch) {
              score += 1;
              mapping[s] = b + lookahead;
              mappingCounts[s] = 1;
              b += lookahead + 1;
              found = true;
              break;
            }
          }
        }

        const nonBlankCount = searchLines.filter(l => superNormalize(l) !== "").length;
        if (score > bestScore && score >= Math.ceil(nonBlankCount * 0.4)) {
          bestScore = score;
          bestIdx = i;
          bestMatchedLength = b - i;
          bestMapping = mapping;
          bestMappingCounts = mappingCounts;
        }
      }

      if (bestScore > 0) {
        foundIndex = bestIdx;
        matchedLength = bestMatchedLength;
        foundMapping = bestMapping;
        foundMappingCounts = bestMappingCounts;
      }
    }

    if (foundIndex !== -1) {
      if (foundMapping) {
        const newLines: { text: string, type: "normal" | "added" }[] = [];
        let b = foundIndex;

        for (const op of ops) {
          if (op.type === "added") {
            newLines.push({ text: op.text, type: "added" });
          } else {
            const mappedB = op.searchIdx !== undefined ? foundMapping[op.searchIdx] : -1;
            if (mappedB !== -1) {
              while (b < mappedB) {
                newLines.push(baseLines[b]);
                b++;
              }
              const count = (op.searchIdx !== undefined && foundMappingCounts) ? foundMappingCounts[op.searchIdx] : 1;
              if (op.type === "normal") {
                for (let i = 0; i < count; i++) {
                  newLines.push(baseLines[b + i]);
                }
              }
              b += count;
            }
          }
        }
        while (b < foundIndex + matchedLength) {
          newLines.push(baseLines[b]);
          b++;
        }
        baseLines.splice(foundIndex, matchedLength, ...newLines);
      } else {
        const replaceLines: { text: string, type: "normal" | "added" }[] = [];
        for (const op of ops) {
          if (op.type === "added" || op.type === "normal") {
            replaceLines.push({ text: op.text, type: op.type });
          }
        }
        baseLines.splice(foundIndex, matchedLength, ...replaceLines);
      }
      debug(`[applyPatch] Successfully applied hunk starting at old line ${hunk.oldStart}. Patched index: ${foundIndex}`);
    } else {
      if (workingText.trim() === "") {
        const replaceLines: { text: string, type: "normal" | "added" }[] = [];
        for (const op of ops) {
          if (op.type === "added" || op.type === "normal") {
            replaceLines.push({ text: op.text, type: op.type });
          }
        }
        return replaceLines;
      }
      warn(`[applyPatch] Could not apply hunk starting at line ${hunk.oldStart} (no match found!)`);
    }
  }

  return baseLines;
}

const VALID_NOTION_LANGUAGES = new Set([
  "abap", "arduino", "bash", "basic", "c", "clojure", "coffeescript", "cpp", "csharp", "css",
  "dart", "diff", "docker", "elixir", "elm", "erlang", "flow", "fortran", "fsharp", "gherkin",
  "glsl", "go", "graphql", "groovy", "haskell", "html", "java", "javascript", "json", "julia",
  "kotlin", "latex", "less", "lisp", "livescript", "lua", "makefile", "markdown", "markup",
  "matlab", "mermaid", "nix", "objective-c", "ocaml", "pascal", "perl", "php", "plain text",
  "powershell", "prolog", "protobuf", "python", "r", "reason", "ruby", "rust", "sass", "scala",
  "scheme", "scss", "shell", "sql", "swift", "typescript", "vb.net", "verilog", "vhdl",
  "visual basic", "webassembly", "xml", "yaml"
]);

function getNotionLanguage(lang: string): string {
  const cleaned = lang.trim().toLowerCase();
  if (cleaned === "js") return "javascript";
  if (cleaned === "ts") return "typescript";
  if (cleaned === "sh") return "shell";
  if (cleaned === "py") return "python";
  if (VALID_NOTION_LANGUAGES.has(cleaned)) {
    return cleaned;
  }
  return "plain text";
}

function chunkTextIntoRichText(text: string, isAdded: boolean = false): Record<string, unknown>[] {
  const richText: Record<string, unknown>[] = [];
  let remaining = text;
  if (!remaining) return [];
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, 1900);
    const annotation: Record<string, unknown> = {};
    if (isAdded) {
      annotation.annotations = { color: "green" };
    }
    richText.push({
      type: "text",
      text: {
        content: chunk,
      },
      ...annotation,
    });
    remaining = remaining.slice(1900);
  }
  return richText;
}

function splitTextIntoRichText(text: string, isAdded: boolean = false): Record<string, unknown>[] {
  const tokens = [];
  let remaining = text;
  if (!remaining) return [];

  const regex = /(\*\*(.*?)\*\*)|(?<!\w)(_([^_]+)_(?!\w))|(\*(.*?)\*)|(~~(.*?)~~)|(`([^`]+)`)|(?:\[(.*?)\]\((.*?)\))/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ text: text.slice(lastIndex, match.index), type: "text" });
    }

    if (match[1] !== undefined) {
      tokens.push({ text: match[2], type: "bold" });
    } else if (match[3] !== undefined) {
      tokens.push({ text: match[4], type: "italic" });
    } else if (match[5] !== undefined) {
      tokens.push({ text: match[6], type: "italic" });
    } else if (match[7] !== undefined) {
      tokens.push({ text: match[8], type: "strikethrough" });
    } else if (match[9] !== undefined) {
      tokens.push({ text: match[10], type: "code" });
    } else if (match[11] !== undefined && match[12] !== undefined) {
      tokens.push({ text: match[11], url: match[12], type: "link" });
    } else {
      tokens.push({ text: match[0], type: "text" });
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    tokens.push({ text: text.slice(lastIndex), type: "text" });
  }

  const richText: Record<string, unknown>[] = [];
  
  for (const token of tokens) {
    if (!token.text && token.type !== "link") continue;
    
    let remainingText = token.text || "link";

    while (remainingText.length > 0) {
      const chunk = remainingText.slice(0, 1900);
      remainingText = remainingText.slice(1900);
      
      const annotations: any = {};
      if (isAdded) annotations.color = "green";
      
      if (token.type === "bold") annotations.bold = true;
      else if (token.type === "italic") annotations.italic = true;
      else if (token.type === "strikethrough") annotations.strikethrough = true;
      else if (token.type === "code") annotations.code = true;

      const rtObj: any = {
        type: "text",
        text: {
          content: chunk
        }
      };

      if (token.type === "link" && token.url) {
        let validUrl = token.url.trim();
        if (!validUrl.startsWith("http://") && !validUrl.startsWith("https://")) {
            validUrl = "https://" + validUrl;
        }
        rtObj.text.link = { url: validUrl.slice(0, 1000) };
      }

      if (Object.keys(annotations).length > 0) {
        rtObj.annotations = annotations;
      }

      richText.push(rtObj);
    }
  }

  return richText;
}

function buildRichTextForCodeBlock(codeBlockLines: Array<{ text: string, type: "normal" | "added" }>): Record<string, unknown>[] {
  const richText: Record<string, unknown>[] = [];
  if (codeBlockLines.length === 0) return [];

  let currentType = codeBlockLines[0].type;
  let currentGroup: string[] = [];

  for (let idx = 0; idx < codeBlockLines.length; idx++) {
    const item = codeBlockLines[idx];
    const suffix = idx === codeBlockLines.length - 1 ? "" : "\n";
    
    if (item.type !== currentType) {
      richText.push(...chunkTextIntoRichText(currentGroup.join(""), currentType === "added"));
      currentType = item.type;
      currentGroup = [item.text + suffix];
    } else {
      currentGroup.push(item.text + suffix);
    }
  }
  if (currentGroup.length > 0) {
    richText.push(...chunkTextIntoRichText(currentGroup.join(""), currentType === "added"));
  }

  return richText;
}

function parseTableRows(lines: Array<{ text: string, type: "normal" | "added" }>) {
  const rows: Array<{ cells: string[], type: "normal" | "added" }> = [];
  let currentRow: { cells: string[], type: "normal" | "added", endsWithPipe: boolean } | null = null;
  
  let numCols = 0;
  if (lines.length > 0) {
    const firstLine = lines[0].text.trim();
    if (firstLine.startsWith("|")) {
      const parts = lines[0].text.split("|").slice(1);
      if (firstLine.endsWith("|") && parts.length > 0) {
        parts.pop();
      }
      numCols = parts.length;
    }
  }

  for (const line of lines) {
    const lineText = line.text.trim();
    if (lineText.startsWith("|")) {
      if (currentRow) {
        rows.push({ cells: currentRow.cells, type: currentRow.type });
      }
      const parts = line.text.split("|");
      const rawCells = parts.slice(1);
      let endsWithPipe = false;
      if (lineText.endsWith("|") && rawCells.length > 0) {
        rawCells.pop();
        endsWithPipe = true;
      }
      currentRow = {
        cells: rawCells.map(c => c.trim()),
        type: line.type,
        endsWithPipe
      };
    } else {
      if (currentRow && (!currentRow.endsWithPipe || currentRow.cells.length < numCols)) {
        const parts = line.text.split("|");
        if (currentRow.cells.length > 0) {
          currentRow.cells[currentRow.cells.length - 1] += "\n" + parts[0].trim();
        } else {
          currentRow.cells.push(parts[0].trim());
        }
        const rawCells = parts.slice(1);
        let endsWithPipe = false;
        if (lineText.endsWith("|") && rawCells.length > 0) {
          rawCells.pop();
          endsWithPipe = true;
        }
        currentRow.cells.push(...rawCells.map(c => c.trim()));
        currentRow.endsWithPipe = endsWithPipe;
      } else {
        if (currentRow) {
          rows.push({ cells: currentRow.cells, type: currentRow.type });
          currentRow = null;
        }
        if (lineText !== "") {
          currentRow = {
            cells: [lineText],
            type: line.type,
            endsWithPipe: false
          };
        }
      }
    }
  }
  if (currentRow) {
    rows.push({ cells: currentRow.cells, type: currentRow.type });
  }
  return { rows, numCols };
}

function isTableContinuation(lineText: string, tableLines: Array<{ text: string, type: "normal" | "added" }>): boolean {
  const trimmed = lineText.trim();
  if (trimmed.startsWith("```")) return false;
  if (trimmed.startsWith(">")) return false;
  if (trimmed.match(/^(#{1,6})\s+/)) return false;
  if (trimmed === "---" || trimmed === "***" || trimmed === "___") return false;

  const { rows, numCols } = parseTableRows(tableLines);
  if (rows.length === 0) return true;
  const lastRow = rows[rows.length - 1];
  
  if (lastRow.cells.length < numCols) {
    return true;
  }
  return false;
}

function buildTableBlock(lines: Array<{ text: string, type: "normal" | "added" }>): Record<string, unknown> {
  const { rows, numCols } = parseTableRows(lines);

  let hasHeader = false;
  let dataRows = rows;
  
  if (rows.length >= 2) {
    const isSeparator = rows[1].cells.every(c => c.replace(/[:-]/g, "").trim() === "");
    if (isSeparator) {
      hasHeader = true;
      dataRows = [rows[0], ...rows.slice(2)];
    }
  }

  if (dataRows.length > 100) {
    dataRows = dataRows.slice(0, 100);
  }

  const tableWidth = Math.max(...dataRows.map(r => r.cells.length), 1);

  const tableRows = dataRows.map(row => {
    let cells = row.cells;
    if (cells.length < tableWidth) {
      cells = [...cells, ...Array(tableWidth - cells.length).fill("")];
    } else if (cells.length > tableWidth) {
      cells = cells.slice(0, tableWidth);
    }

    return {
      type: "table_row",
      table_row: {
        cells: cells.map(c => splitTextIntoRichText(c, row.type === "added"))
      }
    };
  });

  return {
    object: "block",
    type: "table",
    table: {
      table_width: tableWidth,
      has_column_header: hasHeader,
      has_row_header: false,
      children: tableRows
    }
  };
}

export function markdownToRichNotionBlocks(linesInput: string | Array<{ text: string, type: "normal" | "added" }>): Record<string, unknown>[] {
  const lines = typeof linesInput === "string"
    ? linesInput.split(/\r?\n/).map(t => ({ text: t, type: "normal" as const }))
    : linesInput;
  const blocks: Record<string, unknown>[] = [];
  
  let inCodeBlock = false;
  let codeBlockLines: Array<{ text: string, type: "normal" | "added" }> = [];
  let codeLanguage = "plain text";
  let codeFenceLength = 3;

  let inTable = false;
  let tableLines: Array<{ text: string, type: "normal" | "added" }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (inCodeBlock) {
      const fenceMatch = line.text.match(/^(`{3,})/);
      if (fenceMatch && fenceMatch[1].length >= codeFenceLength) {
        blocks.push({
          object: "block",
          type: "code",
          code: {
            rich_text: buildRichTextForCodeBlock(codeBlockLines),
            language: codeLanguage,
          },
        });
        inCodeBlock = false;
        codeBlockLines = [];
      } else {
        codeBlockLines.push(line);
      }
      continue;
    }

    const codeStartMatch = line.text.match(/^(`{3,})(.*)$/);
    if (codeStartMatch) {
      if (inTable) {
        blocks.push(buildTableBlock(tableLines));
        inTable = false;
        tableLines = [];
      }
      inCodeBlock = true;
      codeFenceLength = codeStartMatch[1].length;
      codeLanguage = getNotionLanguage(codeStartMatch[2]);
      continue;
    }

    const trimmedText = line.text.trim();
    const isTableLine = trimmedText.startsWith("|");

    if (inTable) {
      const isStructuralLine = 
        trimmedText.startsWith("```") ||
        trimmedText.startsWith(">") ||
        /^(#{1,6})\s+/.test(trimmedText) ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(trimmedText) ||
        /^\s*[-+*]\s+/.test(line.text) ||
        /^\s*\d+\.\s+/.test(line.text);

      if (isStructuralLine) {
        blocks.push(buildTableBlock(tableLines));
        inTable = false;
        tableLines = [];
      } else if (trimmedText.startsWith("|") || isTableContinuation(line.text, tableLines)) {
        tableLines.push(line);
        continue;
      } else {
        let nextTableLineFound = false;
        for (let j = i + 1; j < lines.length; j++) {
          const nextTrimmed = lines[j].text.trim();
          if (nextTrimmed === "") continue;
          if (nextTrimmed.startsWith("|")) {
            nextTableLineFound = true;
          }
          break;
        }
        if (nextTableLineFound) {
          tableLines.push(line);
          continue;
        }

        blocks.push(buildTableBlock(tableLines));
        inTable = false;
        tableLines = [];
      }
    } else if (isTableLine) {
      inTable = true;
      tableLines.push(line);
      continue;
    }

    if (trimmedText === "") {
      continue;
    }

    if (line.text === "---" || line.text === "***" || line.text === "___") {
      blocks.push({
        object: "block",
        type: "divider",
        divider: {},
      });
      continue;
    }

    const headingMatch = line.text.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length, 6);
      const type = `heading_${level}` as "heading_1" | "heading_2" | "heading_3" | "heading_4" | "heading_5" | "heading_6";
      blocks.push({
        object: "block",
        type,
        [type]: {
          rich_text: splitTextIntoRichText(headingMatch[2], line.type === "added"),
        },
      });
      continue;
    }

    const todoMatch = line.text.match(/^\s*[-+]\s+\[([ xX])\](?:\s+(.*))?$/);
    if (todoMatch) {
      const checked = todoMatch[1].toLowerCase() === "x";
      blocks.push({
        object: "block",
        type: "to_do",
        to_do: {
          rich_text: splitTextIntoRichText(todoMatch[2] || "", line.type === "added"),
          checked,
        },
      });
      continue;
    }

    const bulletMatch = line.text.match(/^\s*[-+]\s+(.*)$/);
    if (bulletMatch) {
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: splitTextIntoRichText(bulletMatch[1], line.type === "added"),
        },
      });
      continue;
    }

    const numberMatch = line.text.match(/^\s*\d+\.\s+(.*)$/);
    if (numberMatch) {
      blocks.push({
        object: "block",
        type: "numbered_list_item",
        numbered_list_item: {
          rich_text: splitTextIntoRichText(numberMatch[1], line.type === "added"),
        },
      });
      continue;
    }

    const quoteMatch = line.text.match(/^\s*>\s*(.*)$/);
    if (quoteMatch) {
      blocks.push({
        object: "block",
        type: "quote",
        quote: {
          rich_text: splitTextIntoRichText(quoteMatch[1], line.type === "added"),
        },
      });
      continue;
    }

    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: splitTextIntoRichText(line.text, line.type === "added"),
      },
    });
  }

  if (inTable) {
    blocks.push(buildTableBlock(tableLines));
  }

  if (inCodeBlock) {
    blocks.push({
      object: "block",
      type: "code",
      code: {
        rich_text: buildRichTextForCodeBlock(codeBlockLines),
        language: codeLanguage,
      },
    });
  }

  return blocks;
}

export function compileRepomixToCodeBlocks(text: string): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  const maxChunkSize = 30000;
  let remaining = text;
  
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, maxChunkSize);
    remaining = remaining.slice(maxChunkSize);
    
    const richText: Record<string, unknown>[] = [];
    let chunkRemaining = chunk;
    while (chunkRemaining.length > 0) {
      const rtText = chunkRemaining.slice(0, 1900);
      chunkRemaining = chunkRemaining.slice(1900);
      richText.push({
        type: "text",
        text: {
          content: rtText,
        },
      });
    }
    
    blocks.push({
      object: "block",
      type: "code",
      code: {
        rich_text: richText,
        language: "markdown",
      },
    });
  }
  
  return blocks;
}



const READ_ONLY_KEYS = [
  "id",
  "parent",
  "created_time",
  "created_by",
  "last_edited_time",
  "last_edited_by",
  "has_children",
  "archived",
  "in_trash"
];

function cleanBlock(obj: any): any {
  if (Array.isArray(obj)) {
    return obj.map(cleanBlock);
  } else if (obj !== null && typeof obj === 'object') {
    const newObj: any = {};
    for (const key of Object.keys(obj)) {
      if (READ_ONLY_KEYS.includes(key)) {
        continue;
      }
      const val = obj[key];
      if (val !== null && val !== undefined) {
        newObj[key] = cleanBlock(val);
      }
    }
    return newObj;
  }
  return obj;
}



function sanitizeRichText(richTexts: any[]): any[] {
  if (!richTexts) return [];
  const result: any[] = [];
  for (const rt of richTexts) {
    if (rt.text && rt.text.content && rt.text.content.length > 1900) {
      let content = rt.text.content;
      while (content.length > 0) {
        result.push({
          ...rt,
          text: {
            ...rt.text,
            content: content.slice(0, 1900)
          }
        });
        content = content.slice(1900);
      }
    } else {
      result.push(rt);
    }
  }
  return result;
}

async function getBranchDbId(thoughtId: string): Promise<string> {
  let resolvedBranchDbId = process.env.NOTION_BRANCH_DB_ID;
  if (resolvedBranchDbId) return resolvedBranchDbId;

  try {
    const projectPage = await notion.pages.retrieve({ page_id: thoughtId }) as any;
    if (projectPage && projectPage.parent) {
      let projectDbId = "";
      if (projectPage.parent.type === "database_id") {
        projectDbId = projectPage.parent.database_id;
      } else if (projectPage.parent.type === "data_source_id") {
        projectDbId = projectPage.parent.data_source_id;
      }
      
      if (projectDbId) {
        const db = await notion.databases.retrieve({ database_id: projectDbId }) as any;
        const branchProp = findProperty(db.properties, "Branch");
        if (branchProp && branchProp.type === "relation" && branchProp.relation) {
          const dbId = branchProp.relation.database_id || branchProp.relation.data_source_id;
          if (dbId) return dbId;
        }
      }
    }
  } catch {}
  
  throw new Error("Could not resolve Branch Database ID");
}

async function getBranchesForProject(projectId: string, branchDbId: string) {
  const response = await notion.dataSources.query({
    data_source_id: branchDbId,
    filter: {
      property: "Project",
      relation: { contains: projectId },
    },
    sorts: [
      {
        timestamp: "created_time",
        direction: "descending",
      },
    ],
  });
  return response.results as unknown as NotionPage[];
}

export async function handleUserComment(triggeredId: string) {
  debug(`Starting handleUserComment for ID: ${triggeredId}`);

  const entryDbIdResolved = await resolveDataSourceId(ENTRY_DB_ID);

  const pageObj = await notion.pages.retrieve({ page_id: triggeredId }) as any;
  const parentId = pageObj?.parent?.database_id || pageObj?.parent?.data_source_id;

  let projectId = "";
  let targetEntry: any = null;
  let sourceEntry: any = null;

  if (parentId === ENTRY_DB_ID || parentId === entryDbIdResolved) {
    targetEntry = pageObj;
    projectId = findProperty(pageObj.properties || {}, "Project")?.relation?.[0]?.id;
    if (!projectId) {
      throw new Error(`Entry ${triggeredId} is not linked to any Project.`);
    }

    const recentResponse = await notion.dataSources.query({
      data_source_id: entryDbIdResolved,
      filter: {
        property: "Project",
        relation: { contains: projectId },
      },
      sorts: [{ timestamp: "created_time", direction: "descending" }],
    });

    const results = recentResponse.results;
    const targetIdx = results.findIndex((r: any) => r.id === triggeredId);
    if (targetIdx !== -1 && targetIdx + 1 < results.length) {
      sourceEntry = results[targetIdx + 1];
    } else if (targetIdx === -1 && results.length > 0) {
      sourceEntry = results.find((r: any) => r.id !== triggeredId);
    }
  } else {
    projectId = triggeredId;

    const recentResponse = await notion.dataSources.query({
      data_source_id: entryDbIdResolved,
      filter: {
        property: "Project",
        relation: { contains: projectId },
      },
      sorts: [{ timestamp: "created_time", direction: "descending" }],
      page_size: 1,
    });

    if (recentResponse.results.length > 0) {
      sourceEntry = recentResponse.results[0];
    }

    const createResult = await createEntry({
      thoughtId: projectId,
      pageType: "CHAT CMNT",
    });

    if (createResult.pageId) {
      targetEntry = await notion.pages.retrieve({ page_id: createResult.pageId });
    }
  }

  if (!targetEntry || !sourceEntry) {
    debug("Missing target or source entry. Cannot copy comments.");
    return;
  }

  debug(`Scanning source entry ${sourceEntry.id} for comments to attach to ${targetEntry.id}`);

  // Update properties
  try {
    let finalTitle = findProperty((targetEntry as any).properties || {}, "Name")?.title?.[0]?.plain_text ?? "";

    if (!finalTitle || !/^\d+$/.test(finalTitle.trim())) {
      const nextNumber = await getNextEntryNumber(projectId, targetEntry.id);
      finalTitle = String(nextNumber);
    }

    const propertiesToUpdate: any = {
      "Entries Referenced": { relation: [{ id: sourceEntry.id }] },
    };

    if (finalTitle) {
      propertiesToUpdate.Name = { title: [{ text: { content: finalTitle } }] };
    }

    const updatePayload: any = {
      page_id: targetEntry.id,
      properties: propertiesToUpdate
    };

    await notion.pages.update(updatePayload);
    debug(`Updated targetEntry properties: EntriesReferenced=${sourceEntry.id}, Title=${finalTitle}`);
  } catch (err) {
    warn(`Failed to update targetEntry properties:`, err);
  }

    // 2. Fetch all blocks from sourceEntry recursively
  const sourceBlocks = await fetchBlocksRecursive(sourceEntry.id);

  // Fetch all blocks from the memorandum page (if exists) recursively
  const memorandumBlocks: any[] = [];
  let memorandumPageId = "";
  try {
    const memorandumDbIdResolved = await resolveDataSourceId(MEMORANDUM_DB_ID);
    const memorandumPagesResponse = await notion.dataSources.query({
      data_source_id: memorandumDbIdResolved,
      filter: {
        property: "Project",
        relation: { contains: projectId }
      }
    });

    if (memorandumPagesResponse.results.length > 0) {
      memorandumPageId = memorandumPagesResponse.results[0].id;
      const memoBlocksList = await fetchBlocksRecursive(memorandumPageId);
      memorandumBlocks.push(...memoBlocksList);
    }
  } catch (err) {
    warn("Failed to retrieve memorandum page blocks for comments copy:", err);
  }

  function getAllBlocksFlattened(blocksList: any[]): any[] {
    const result: any[] = [];
    for (const b of blocksList) {
      result.push(b);
      if (b.children && b.children.length > 0) {
        result.push(...getAllBlocksFlattened(b.children));
      }
    }
    return result;
  }

  const allSourceBlocksFlat = getAllBlocksFlattened(sourceBlocks);
  const allMemorandumBlocksFlat = getAllBlocksFlattened(memorandumBlocks);

    // 3. For each block/page, fetch comments
  const newBlocks: any[] = [];
  const itemsToScan: Array<{ id: string; type: string; raw?: any }> = [
    ...allSourceBlocksFlat.map(b => ({ id: b.id, type: b.type, raw: b })),
    ...allMemorandumBlocksFlat.map(b => ({ id: b.id, type: b.type, raw: b })),
    { id: sourceEntry.id, type: "page" },
    ...(memorandumPageId ? [{ id: memorandumPageId, type: "page" }] : [])
  ];

  const seenCommentIds = new Set<string>();

  for (const item of itemsToScan) {
    try {
      const commentsRes = await notion.comments.list({ block_id: item.id });
      
      const directComments = commentsRes.results.filter((comment: any) => {
        if (seenCommentIds.has(comment.id)) return false;
        const parentId = comment.parent?.block_id || comment.parent?.page_id || comment.parent?.database_id;
        return parentId === item.id;
      });

      if (directComments.length > 0) {
        // Find text content
        let blockTextRichText: any[] = [];
        if (item.type !== "page" && item.raw && item.raw[item.type]) {
          if (item.raw[item.type].rich_text) {
            blockTextRichText = sanitizeRichText(item.raw[item.type].rich_text);
          } else if (item.type === "table_row" && item.raw.table_row?.cells) {
            const cellTexts: string[] = [];
            for (const cell of item.raw.table_row.cells) {
              cellTexts.push(getRichTextPlain(cell));
            }
            const rowStr = `| ${cellTexts.join(" | ")} |`;
            blockTextRichText = [{
              type: "text",
              text: { content: rowStr }
            }];
          }
        }

        if (blockTextRichText.length > 0) {
          newBlocks.push({
            object: "block",
            type: "quote",
            quote: { rich_text: blockTextRichText }
          });
        }

        // Add the comments
        for (const comment of directComments) {
           seenCommentIds.add(comment.id);
           newBlocks.push({
             object: "block",
             type: "callout",
             callout: {
               rich_text: sanitizeRichText(comment.rich_text),
               icon: { type: "emoji", emoji: "💬" }
             }
           });
        }
      }
    } catch (err) {
      // no comments or error fetching
    }
  }

  // 4. Append newBlocks to targetEntry
  if (newBlocks.length > 0) {
    const CHUNK = 100;
    for (let i = 0; i < newBlocks.length; i += CHUNK) {
      await notion.blocks.children.append({
        block_id: targetEntry.id,
        children: newBlocks.slice(i, i + CHUNK) as any,
      });
    }
    debug(`Appended ${newBlocks.length} comment blocks to target entry.`);
  } else {
    debug("No comments found.");
    await notion.blocks.children.append({
      block_id: targetEntry.id,
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: {
            rich_text: [{ type: "text", text: { content: "No comments found on the previous entry." } }]
          }
        }
      ] as any
    });
  }
}

export async function handleMemoUpdate(thoughtId: string): Promise<void> {
  console.log(`[handleMemoUpdate] Starting. Project ID: ${thoughtId}`);

  const entryDbId = await resolveDataSourceId(ENTRY_DB_ID);
  console.log(`[handleMemoUpdate] Resolved entryDbId: ${entryDbId}`);

  const memorandumDbIdResolved = await resolveDataSourceId(MEMORANDUM_DB_ID);
  console.log(`[handleMemoUpdate] Resolved memorandumDbIdResolved: ${memorandumDbIdResolved}`);

  // 1. Gather all MEMO RESP entries for the project.
  // MEMO EXPO is outbound-only and must not participate in memorandum reconstruction.
  const entriesResponse = await notion.dataSources.query({
    data_source_id: entryDbId,
    filter: {
      property: "Project",
      relation: { contains: thoughtId }
    }
  });
  console.log(`[handleMemoUpdate] Entries query returned ${entriesResponse.results?.length} results`);

  const memorandumEntries = entriesResponse.results.filter((entry: any) => {
    const type = findProperty(entry.properties || {}, "Type")?.select?.name;
    return type === "MEMO RESP";
  });
  console.log(`[handleMemoUpdate] Filtered to ${memorandumEntries.length} memorandum entries`);

  // Sort them chronologically by their Name (converted to integer or alphanumerically)
  memorandumEntries.sort((a: any, b: any) => {
    const nameA = findProperty(a.properties || {}, "Name")?.title?.[0]?.plain_text || "";
    const nameB = findProperty(b.properties || {}, "Name")?.title?.[0]?.plain_text || "";
    const matchA = nameA.match(/\d+/);
    const matchB = nameB.match(/\d+/);
    const numA = matchA ? parseInt(matchA[0], 10) : NaN;
    const numB = matchB ? parseInt(matchB[0], 10) : NaN;
    if (!isNaN(numA) && !isNaN(numB)) {
      return numA - numB;
    }
    return nameA.localeCompare(nameB, undefined, { numeric: true });
  });

  debug(`Found ${memorandumEntries.length} memorandum entries to process`);

  // 2. Apply git diffs sequentially
  let currentContent = "";
  let latestEntryNumber = "";

  const entryContents = await Promise.all(
    memorandumEntries.map((entry: any) => readPageContent(entry.id))
  );
  console.log(`[handleMemoUpdate] Read content of all ${memorandumEntries.length} entries`);

  for (let i = 0; i < memorandumEntries.length; i++) {
    const entry = memorandumEntries[i];
    const nameProp = findProperty((entry as any).properties || {}, "Name");
    const entryNum = nameProp?.title?.[0]?.plain_text ?? "";
    if (entryNum) {
      latestEntryNumber = entryNum;
    }

    const content = entryContents[i];
    const unwrapped = unwrapCodeFences(content);

    if (i === 0 && isDiff(unwrapped)) {
      throw new Error("[handleMemoUpdate] First MEMO RESP must be full text, but received unified diff.");
    }

    if (isDiff(unwrapped)) {
      console.log(`[handleMemoUpdate] Applying diff from MEMO RESP. Unwrapped length: ${unwrapped.length}`);
      const patchedLines = applyPatch(currentContent, unwrapped);
      currentContent = patchedLines.map(l => l.text).join("\n");
      console.log(`[handleMemoUpdate] Finished applying patch. New content length: ${currentContent.length}`);
    } else {
      console.log(`[handleMemoUpdate] Using full text from MEMO RESP.`);
      currentContent = unwrapped;
    }
  }

  // 3. Find existing memorandum page in Memorandum DB for this project
  console.log(`[handleMemoUpdate] Querying Memorandum DB: ${memorandumDbIdResolved} for project: ${thoughtId}`);
  const memorandumPagesResponse = await notion.dataSources.query({
    data_source_id: memorandumDbIdResolved,
    filter: {
      property: "Project", relation: { contains: thoughtId }
    }
  });
  console.log(`[handleMemoUpdate] Memorandum DB query returned ${memorandumPagesResponse.results?.length} results`);

  let memorandumPageId = "";
  const results = memorandumPagesResponse.results;

  if (results.length > 0) {
    memorandumPageId = results[0].id;
    console.log(`[handleMemoUpdate] Using existing memorandum page ${memorandumPageId}`);

    // Update title/Name to the chronological number from entries
    console.log(`[handleMemoUpdate] Updating memorandum page title to: ${latestEntryNumber || "1"}`);
    await notion.pages.update({
      page_id: memorandumPageId,
      properties: {
        Name: { title: [{ text: { content: latestEntryNumber || "1" } }] }
      }
    });

    // Enforce "only allow 1 memorandum only" by archiving other duplicate memorandum pages
    if (results.length > 1) {
      console.log(`[handleMemoUpdate] Archiving ${results.length - 1} duplicate memorandum pages`);
      await Promise.all(
        results.slice(1).map(r => notion.pages.update({ page_id: r.id, in_trash: true }))
      );
    }
  } else {
    console.log(`[handleMemoUpdate] Creating new memorandum page in Memorandum DB`);
    const memorandumPage = await notion.pages.create({
      parent: { data_source_id: memorandumDbIdResolved },
      properties: {
        Name: { title: [{ text: { content: latestEntryNumber || "1" } }] },
        Project: { relation: [{ id: thoughtId }] }
      }
    });
    memorandumPageId = memorandumPage.id;
    console.log(`[handleMemoUpdate] Created new memorandum page: ${memorandumPageId}`);
  }

  // 4. Link Project to Memorandum
  try {
    console.log(`[handleMemoUpdate] Linking project ${thoughtId} to Memorandum ${memorandumPageId}`);
    await notion.pages.update({
      page_id: thoughtId,
      properties: {
        Memorandum: { relation: [{ id: memorandumPageId }] }
      }
    });
  } catch (err) {
    console.warn(`[handleMemoUpdate] Failed to link Project to Memorandum:`, err);
  }

  // 5. Rebuild memorandum page from the fully patched markdown.
  const forceWipe = false;
  console.log(`[handleMemoUpdate] Rebuilding memorandum page: ${memorandumPageId} with content length: ${currentContent.length}`);
  await updatePageBlocks(memorandumPageId, currentContent, false, forceWipe);
  console.log(`[handleMemoUpdate] Finished updating memorandum page ${memorandumPageId} with latest content (forceWipe: ${forceWipe})`);
}

function getRichTextPlain(rt: any[]): string {
  return rt?.map((t: any) => t.plain_text ?? t.text?.content ?? "").join("") ?? "";
}

function getRichTextMarkdown(rt: any[]): string {
  return rt?.map((t: any) => {
    let text = t.plain_text ?? t.text?.content ?? "";
    if (!text) return "";

    const annotations = t.annotations || {};
    if (annotations.code) {
      text = `\`${text}\``;
    } else {
      if (annotations.bold) text = `**${text}**`;
      if (annotations.italic) text = `_${text}_`;
      if (annotations.strikethrough) text = `~~${text}~~`;
    }

    const url = t.href ?? t.text?.link?.url;
    if (url) {
      text = `[${text}](${url})`;
    }

    return text;
  }).join("") ?? "";
}

function serializeBlockToMarkdown(block: any, childBlocksMap: Map<string, any[]>): string {
  const type = block.type;
  const data = block[type];
  if (!data) return "";

  switch (type) {
    case "heading_1":
      return `# ${getRichTextMarkdown(data.rich_text)}`;
    case "heading_2":
      return `## ${getRichTextMarkdown(data.rich_text)}`;
    case "heading_3":
      return `### ${getRichTextMarkdown(data.rich_text)}`;
    case "heading_4":
      return `#### ${getRichTextMarkdown(data.rich_text)}`;
    case "heading_5":
      return `##### ${getRichTextMarkdown(data.rich_text)}`;
    case "heading_6":
      return `###### ${getRichTextMarkdown(data.rich_text)}`;
    case "bulleted_list_item":
      return `- ${getRichTextMarkdown(data.rich_text)}`;
    case "numbered_list_item":
      return `1. ${getRichTextMarkdown(data.rich_text)}`;
    case "quote":
      return `> ${getRichTextMarkdown(data.rich_text)}`;
    case "callout":
      return getRichTextMarkdown(data.rich_text);
    case "to_do":
      return `- [${data.checked ? "x" : " "}] ${getRichTextMarkdown(data.rich_text)}`;
    case "toggle":
      return getRichTextMarkdown(data.rich_text);
    case "divider":
      return `---`;
    case "paragraph":
      return getRichTextMarkdown(data.rich_text);
    case "code":
      return `\`\`\`\n${getRichTextPlain(data.rich_text)}\n\`\`\``;
    case "table": {
      const rows = childBlocksMap.get(block.id) || data.children || [];
      const rowStrings = rows.map((row: any) => {
        const cells = row.table_row?.cells || [];
        const cellStrings = cells.map((cell: any) => getRichTextMarkdown(cell));
        return `| ${cellStrings.join(" | ")} |`;
      });
      if (rowStrings.length === 0) return "";
      if (data.has_column_header) {
        const colCount = rows[0].table_row?.cells?.length || 0;
        const separator = `| ${Array(colCount).fill("---").join(" | ")} |`;
        return [rowStrings[0], separator, ...rowStrings.slice(1)].join("\n");
      }
      return rowStrings.join("\n");
    }
    default:
      return "";
  }
}

function areBlocksEqual(b1md: string, b2md: string): boolean {
  // Normalize whitespace: replace multiple spaces with a single space.
  // Normalize table separators: remove spaces around dashes in table separators.
  // Ignore list numbering differences by normalizing all numbers to "1."
  const norm = (s: string) => 
    s.trim()
     .replace(/\r\n/g, "\n")
     .replace(/^\d+\.\s+/gm, "1. ")
     .replace(/\s+/g, " ")
     .replace(/\|\s*-+\s*/g, "|---");
  return norm(b1md) === norm(b2md);
}

function diffBlocks(
  oldBlocks: { id?: string; md: string; raw: any }[],
  newBlocks: { md: string; raw: any }[]
): { action: "keep" | "delete" | "insert" | "update"; oldIdx?: number; newIdx?: number }[] {
  const m = oldBlocks.length;
  const n = newBlocks.length;
  
  const dp: number[][] = Array(m + 1).fill(0).map(() => Array(n + 1).fill(0));
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (areBlocksEqual(oldBlocks[i - 1].md, newBlocks[j - 1].md)) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  
  const diff: { action: "keep" | "delete" | "insert" | "update"; oldIdx?: number; newIdx?: number }[] = [];
  let i = m;
  let j = n;
  
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && areBlocksEqual(oldBlocks[i - 1].md, newBlocks[j - 1].md)) {
      diff.unshift({ action: "keep", oldIdx: i - 1, newIdx: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.unshift({ action: "insert", newIdx: j - 1 });
      j--;
    } else {
      diff.unshift({ action: "delete", oldIdx: i - 1 });
      i--;
    }
  }
  
  return diff;
}

async function fetchBlocksRecursive(blockId: string): Promise<any[]> {
  const blocks: any[] = [];
  let hasMore = true;
  let startCursor: string | undefined = undefined;
  while (hasMore) {
    const res = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: startCursor,
    });
    blocks.push(...res.results);
    hasMore = res.has_more;
    startCursor = res.next_cursor ?? undefined;
  }

  for (const block of blocks) {
    if (block.has_children) {
      block.children = await fetchBlocksRecursive(block.id);
    }
  }

  return blocks;
}

const SYNCABLE_TYPES = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "heading_4",
  "heading_5",
  "heading_6",
  "bulleted_list_item",
  "numbered_list_item",
  "quote",
  "callout",
  "code",
  "to_do",
  "toggle",
  "divider",
  "table"
]);

const TEXT_BLOCK_TYPES = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "heading_4",
  "heading_5",
  "heading_6",
  "bulleted_list_item",
  "numbered_list_item",
  "quote",
  "callout",
  "code",
  "to_do",
  "toggle"
]);

function flattenBlocks(
  blocks: any[],
  parentId: string,
  childBlocksMap: Map<string, any[]>
): any[] {
  const flat: any[] = [];

  for (const block of blocks) {
    if (block.children && block.children.length > 0) {
      childBlocksMap.set(block.id, block.children);
    }

    if (SYNCABLE_TYPES.has(block.type)) {
      flat.push({
        id: block.id,
        type: block.type,
        parentBlockId: parentId,
        raw: block,
      });
    }

    if (block.children && block.children.length > 0) {
      flat.push(...flattenBlocks(block.children, block.id, childBlocksMap));
    }
  }

  return flat;
}

export async function updatePageBlocks(
  pageId: string,
  newMarkdown: string,
  keepFirstBlock: boolean = false,
  forceWipe: boolean = false
): Promise<void> {
  // Fast path: skip all fetch/diff when we're going to wipe everything anyway.
  // This saves 10-20s of wasted Notion API calls that caused Vercel timeouts.
  if (forceWipe && !keepFirstBlock) {
    let newBlocks = markdownToRichNotionBlocks(newMarkdown);
    newBlocks = newBlocks.map(b => cleanBlock(b));
    debug(`[updatePageBlocks] forceWipe fast path: erasing + appending ${newBlocks.length} blocks`);

    try {
      await notion.request({
        path: `pages/${pageId}`,
        method: "patch",
        body: { erase_content: true }
      });
      debug(`Successfully erased content using erase_content API for page ${pageId}`);
    } catch (err) {
      warn(`Failed to use erase_content on page ${pageId}, falling back to manual deletion:`, err);
      const existingBlocks = await fetchBlocksRecursive(pageId);
      const CHUNK = 50;
      for (let i = 0; i < existingBlocks.length; i += CHUNK) {
        const chunk = existingBlocks.slice(i, i + CHUNK);
        await Promise.all(
          chunk.map((block) => notion.blocks.delete({ block_id: block.id }).catch(e => warn(`Failed to delete block ${block.id}:`, e)))
        );
      }
    }

    for (let i = 0; i < newBlocks.length; i += 50) {
      await notion.blocks.children.append({
        block_id: pageId,
        children: newBlocks.slice(i, i + 50) as any,
      });
    }
    return;
  }

  debug(`Fetching existing blocks recursively for page ${pageId}`);
  const nestedBlocks = await fetchBlocksRecursive(pageId);

  const childBlocksMap = new Map<string, any[]>();
  const oldContentBlocks = flattenBlocks(nestedBlocks, pageId, childBlocksMap);

  let oldBlocksToSync = oldContentBlocks;
  let firstBlockToKeep: any = null;
  if (keepFirstBlock && oldContentBlocks.length > 0) {
    firstBlockToKeep = oldContentBlocks[0];
    oldBlocksToSync = oldContentBlocks.slice(1);
  }

  let newBlocks = markdownToRichNotionBlocks(newMarkdown);
  newBlocks = newBlocks.map(b => cleanBlock(b));
  debug(`[updatePageBlocks] Converted markdown to ${newBlocks.length} Notion blocks.`);

  const oldSerialized = oldBlocksToSync.map(b => ({
    id: b.id,
    type: b.type,
    parentBlockId: b.parentBlockId,
    md: serializeBlockToMarkdown(b.raw, childBlocksMap),
    raw: b.raw,
  }));

  const newSerialized = newBlocks.map(b => ({
    type: b.type as string,
    md: serializeBlockToMarkdown(b, new Map()),
    raw: b,
  }));

  const diff = diffBlocks(oldSerialized, newSerialized);

  // Pre-process diff steps to merge consecutive delete + insert of same type into update
  const processedSteps: any[] = [];
  let matchCount = 0;

  for (let idx = 0; idx < diff.length; idx++) {
    const current = diff[idx];
    const next = diff[idx + 1];

    if (current.action === "keep") matchCount++;

    if (
      current.action === "delete" &&
      next &&
      next.action === "insert"
    ) {
      const oldBlock = oldSerialized[current.oldIdx!];
      const newBlock = newSerialized[next.newIdx!];

      if (
        TEXT_BLOCK_TYPES.has(oldBlock.type) &&
        TEXT_BLOCK_TYPES.has(newBlock.type) &&
        oldBlock.type === newBlock.type
      ) {
        processedSteps.push({
          action: "update",
          oldIdx: current.oldIdx,
          newIdx: next.newIdx
        });
        matchCount++;
        idx++; // skip next insert
        continue;
      }
    }
    processedSteps.push(current);
  }

  const similarityRatio = matchCount / Math.max(oldSerialized.length, newSerialized.length, 1);
  const hasTableStructuralChange = diff.some((step) => {
    if (step.action === "keep") return false;
    const oldType = step.oldIdx !== undefined ? oldSerialized[step.oldIdx]?.type : undefined;
    const newType = step.newIdx !== undefined ? newSerialized[step.newIdx]?.type : undefined;
    return oldType === "table" || newType === "table";
  });
  const isCompletelyDifferent = similarityRatio < 0.3;
  
  if (forceWipe || (isCompletelyDifferent && oldSerialized.length > 0)) {
    debug(`Wiping and replacing blocks. similarity=${similarityRatio.toFixed(2)}, forceWipe=${forceWipe}`);
    
    let manualWipeNeeded = true;
    if (!keepFirstBlock) {
      try {
        await notion.request({
          path: `pages/${pageId}`,
          method: "patch",
          body: {
            erase_content: true
          }
        });
        manualWipeNeeded = false;
        debug(`Successfully erased content using Notion erase_content API for page ${pageId}`);
      } catch (err) {
        warn(`Failed to use erase_content on page ${pageId}, falling back to manual deletion:`, err);
      }
    }

    if (manualWipeNeeded) {
      const topLevelBlocksToDelete = keepFirstBlock ? nestedBlocks.slice(1) : nestedBlocks;
      
      const CHUNK = 50;
      for (let i = 0; i < topLevelBlocksToDelete.length; i += CHUNK) {
        const chunk = topLevelBlocksToDelete.slice(i, i + CHUNK);
        await Promise.all(
          chunk.map((block) => notion.blocks.delete({ block_id: block.id }).catch(err => warn(`Failed to delete block ${block.id}:`, err)))
        );
      }
    }

    for (let i = 0; i < newBlocks.length; i += 50) {
      await notion.blocks.children.append({
        block_id: pageId,
        children: newBlocks.slice(i, i + 50) as any,
      });
    }
    return;
  }

  const ops: ({ type: "delete"; id: string } | { type: "insert"; blocks: any[]; parentId: string; afterId?: string } | { type: "update"; id: string; oldType: string; newBlock: any })[] = [];
  
  let currentInsertRun: any[] = [];
  let lastKnownBlock: { id: string; parentBlockId: string } | null = null;
  if (keepFirstBlock && firstBlockToKeep) {
    lastKnownBlock = { id: firstBlockToKeep.id, parentBlockId: firstBlockToKeep.parentBlockId || pageId };
  }

  for (const step of processedSteps) {
    if (step.action === "keep") {
      if (currentInsertRun.length > 0) {
        const parentId = lastKnownBlock ? lastKnownBlock.parentBlockId : pageId;
        ops.push({ type: "insert", blocks: currentInsertRun, parentId, afterId: lastKnownBlock?.id });
        currentInsertRun = [];
      }
      const kept = oldSerialized[step.oldIdx!];
      lastKnownBlock = { id: kept.id, parentBlockId: kept.parentBlockId || pageId };
    } else if (step.action === "update") {
      if (currentInsertRun.length > 0) {
        const parentId = lastKnownBlock ? lastKnownBlock.parentBlockId : pageId;
        ops.push({ type: "insert", blocks: currentInsertRun, parentId, afterId: lastKnownBlock?.id });
        currentInsertRun = [];
      }
      const updated = oldSerialized[step.oldIdx!];
      ops.push({
        type: "update",
        id: updated.id,
        oldType: updated.type,
        newBlock: newSerialized[step.newIdx!].raw
      });
      lastKnownBlock = { id: updated.id, parentBlockId: updated.parentBlockId || pageId };
    } else if (step.action === "delete") {
      if (currentInsertRun.length > 0) {
        const parentId = lastKnownBlock ? lastKnownBlock.parentBlockId : pageId;
        ops.push({ type: "insert", blocks: currentInsertRun, parentId, afterId: lastKnownBlock?.id });
        currentInsertRun = [];
      }
      ops.push({ type: "delete", id: oldSerialized[step.oldIdx!].id });
    } else if (step.action === "insert") {
      currentInsertRun.push(newSerialized[step.newIdx!].raw);
    }
  }
  if (currentInsertRun.length > 0) {
    const parentId = lastKnownBlock ? lastKnownBlock.parentBlockId : pageId;
    ops.push({ type: "insert", blocks: currentInsertRun, parentId, afterId: lastKnownBlock?.id });
  }

  // Execute all inserts and updates first, then all deletes last, to prevent archived block errors
  const insertOps = ops.filter((op) => op.type === "insert") as any[];
  const updateOps = ops.filter((op) => op.type === "update") as any[];
  const deleteOps = ops.filter((op) => op.type === "delete") as any[];

  for (const op of insertOps) {
    try {
      const CHUNK = 100;
      let currentAfterId = op.afterId;
      for (let k = 0; k < op.blocks.length; k += CHUNK) {
        const chunkBlocks = op.blocks.slice(k, k + CHUNK);
        const payload: any = {
          block_id: op.parentId,
          children: chunkBlocks as any,
        };

        if (currentAfterId) {
          payload.position = {
            type: "after_block",
            after_block: { id: currentAfterId },
          };
        } else if (k === 0) {
          payload.position = {
            type: "start",
          };
        } else {
          payload.position = {
            type: "after_block",
            after_block: { id: currentAfterId },
          };
        }

        const res = await notion.blocks.children.append(payload);
        if (res.results && res.results.length > 0) {
          currentAfterId = res.results[res.results.length - 1].id;
        }
      }
    } catch (err) {
      warn(`Failed to execute insert operation:`, err);
    }
  }

  for (const op of updateOps) {
    try {
      const blockType = op.newBlock.type;
      const updateData: any = {
        rich_text: op.newBlock[blockType]?.rich_text || []
      };
      if (op.oldType === "code") {
        updateData.language = op.newBlock.code?.language || "plain text";
      }
      if (op.oldType === "to_do") {
        updateData.checked = op.newBlock.to_do?.checked ?? false;
      }
      await notion.blocks.update({
        block_id: op.id,
        [op.oldType]: updateData
      } as any);
    } catch (err) {
      warn(`Failed to update block ${op.id}:`, err);
    }
  }

  for (const op of deleteOps) {
    try {
      await notion.blocks.delete({ block_id: op.id });
    } catch (err) {
      warn(`Failed to delete block ${op.id}:`, err);
    }
  }
}

export async function setExclusiveInclude(projectId: string, entryType: string, activePageId: string): Promise<void> {
  const entryDbId = await resolveDataSourceId(ENTRY_DB_ID);
  
  const response = await notion.dataSources.query({
    data_source_id: entryDbId,
    filter: {
      and: [
        { property: "Project", relation: { contains: projectId } },
        { property: "Type", select: { equals: entryType } }
      ]
    }
  });
  
  const entries = response.results as unknown as NotionPage[];
  
  for (const entry of entries) {
    const isTarget = entry.id === activePageId;
    await notion.pages.update({
      page_id: entry.id,
      properties: {
        Include: { checkbox: isTarget }
      }
    });
  }
}

export async function clearProjectIncludes(projectId: string): Promise<number> {
  const entryDbId = await resolveDataSourceId(ENTRY_DB_ID);
  const entries: NotionPage[] = [];
  let hasMore = true;
  let startCursor: string | undefined;

  while (hasMore) {
    const response = await notion.dataSources.query({
      data_source_id: entryDbId,
      filter: {
        and: [
          { property: "Project", relation: { contains: projectId } },
          { property: "Include", checkbox: { equals: true } }
        ]
      },
      start_cursor: startCursor,
    });

    entries.push(...(response.results as unknown as NotionPage[]));
    hasMore = response.has_more;
    startCursor = response.next_cursor ?? undefined;
  }

  for (const entry of entries) {
    await notion.pages.update({
      page_id: entry.id,
      properties: {
        Include: { checkbox: false }
      }
    });
  }

  return entries.length;
}

export async function applyReferencedIncludeSnapshot(projectId: string, sourceEntryPage: any): Promise<{ referencedCount: number; updatedCount: number; skipped: boolean }> {
  const referencedRelations = findProperty(sourceEntryPage.properties || {}, "Entries Referenced")?.relation || [];
  const referencedIds = referencedRelations.map((rel: { id: string }) => rel.id).filter(Boolean);

  if (referencedIds.length === 0) {
    return { referencedCount: 0, updatedCount: 0, skipped: true };
  }

  const referencedIdSet = new Set(referencedIds);
  const entryDbId = await resolveDataSourceId(ENTRY_DB_ID);
  const projectEntries: NotionPage[] = [];
  let hasMore = true;
  let startCursor: string | undefined;

  while (hasMore) {
    const response = await notion.dataSources.query({
      data_source_id: entryDbId,
      filter: {
        property: "Project",
        relation: { contains: projectId }
      },
      start_cursor: startCursor,
    });

    projectEntries.push(...(response.results as unknown as NotionPage[]));
    hasMore = response.has_more;
    startCursor = response.next_cursor ?? undefined;
  }

  let updatedCount = 0;

  for (const entry of projectEntries) {
    const shouldInclude = referencedIdSet.has(entry.id);
    const currentInclude = findProperty(entry.properties || {}, "Include")?.checkbox ?? false;

    if (currentInclude === shouldInclude) {
      continue;
    }

    await notion.pages.update({
      page_id: entry.id,
      properties: {
        Include: { checkbox: shouldInclude }
      }
    });
    updatedCount++;
  }

  return { referencedCount: referencedIds.length, updatedCount, skipped: false };
}

export async function handleChatLink(projectId: string, entryId: string | undefined, pageObj: any) {
  debug(`Starting handleChatLink for project: ${projectId}, entryId: ${entryId}`);

  if (!entryId) {
    throw new Error("No entryId provided for handleChatLink");
  }

  // 1. Find CHAT URL in Project page properties
  const projectPage = await notion.pages.retrieve({ page_id: projectId }) as any;
  const chatUrlProp = findProperty(projectPage.properties || {}, "CHAT URL");
  const chatUrlRaw =
    chatUrlProp?.url ||
    (Array.isArray(chatUrlProp?.rich_text) ? richTextToPlain(chatUrlProp.rich_text) : "") ||
    "";
  const chatUrl = normalizeNotionUrl(extractFirstUrl(chatUrlRaw) || chatUrlRaw);

  if (!chatUrl) {
    debug("No CHAT URL found in project page properties.");
  }

  const propertiesToUpdate: Record<string, any> = {
    Type: { select: { name: "CHAT LINK" as PageType } },
  };

  // Try to find if there is a URL field on the entry page, and set it if found
  const entryPage = await notion.pages.retrieve({ page_id: entryId }) as any;
  const urlPropKey = findPropertyKey(entryPage.properties || {}, ["Chat URL", "CHAT URL", "URL"]);
  if (urlPropKey && chatUrl) {
    const propType = entryPage.properties[urlPropKey].type;
    if (propType === "url") {
      propertiesToUpdate[urlPropKey] = { url: chatUrl };
    } else if (propType === "rich_text") {
      propertiesToUpdate[urlPropKey] = { rich_text: [{ text: { content: chatUrl } }] };
    }
  }

  // 2. Extract target page ID from CHAT URL
  let targetBlocks: any[] = [];
  let fallbackMarkdown: string | null = null;
  let finalPageObjForFallback: any | null = null;
  let finalTargetPageIdForFallback: string | null = null;
  let appendedAnyBlocks = false;
  const targetPageId = extractNotionPageId(chatUrl);
  if (targetPageId) {
    try {
      let finalTargetPageId = targetPageId;
      const targetPageObj = await notion.pages.retrieve({ page_id: targetPageId }) as any;
      const parent = targetPageObj.parent;
      const parentId = parent?.database_id || parent?.data_source_id;
      if (parentId) {
        const resolvedParentId = await resolveDataSourceId(parentId);
        const resolvedMemoDbId = await resolveDataSourceId(MEMORANDUM_DB_ID);
        const resolvedEntryDbId = await resolveDataSourceId(ENTRY_DB_ID);

        const props = targetPageObj.properties || {};
        const hasTypeProp = !!findPropertyKey(props, ["Type"]);
        const hasRepoUrlProp = !!findPropertyKey(props, ["Repo URL"]);
        const hasChatUrlProp = !!findPropertyKey(props, ["CHAT URL"]);

        let isEntry = hasTypeProp;
        let isMemo = hasRepoUrlProp && !hasTypeProp;
        
        if (!isEntry && !isMemo && !hasChatUrlProp) {
          // Fallback to parent ID check if properties are inconclusive
          isMemo = (resolvedParentId === resolvedMemoDbId) || (parentId === MEMORANDUM_DB_ID);
          isEntry = (resolvedParentId === resolvedEntryDbId) || (parentId === ENTRY_DB_ID);
        }

        if (isMemo) {
          // It's a Memorandum! Link via Memorandum relation
          const memoPropKey = findPropertyKey(entryPage.properties || {}, ["Memorandum", "Memo"]);
          if (memoPropKey) {
            propertiesToUpdate[memoPropKey] = { relation: [{ id: finalTargetPageId }] };
            debug(`Linked entry to Memorandum page ${finalTargetPageId} via property ${memoPropKey}`);
          }
        } else if (isEntry) {
          // It's an Entry! Link via Entries Referenced relation
          const entryPropKey = findPropertyKey(entryPage.properties || {}, ["Entries Referenced", "Entry", "Related Entry", "Related Back to Entry"]);
          if (entryPropKey) {
            propertiesToUpdate[entryPropKey] = { relation: [{ id: finalTargetPageId }] };
            debug(`Linked entry to Entry page ${finalTargetPageId} via property ${entryPropKey}`);
          }
        } else {
          // Project page! Link via its Memorandum relation
          const memoRelations = targetPageObj.properties?.Memorandum?.relation || 
                              findProperty(targetPageObj.properties || {}, "Memorandum")?.relation || [];
          if (memoRelations.length > 0) {
            const memoId = memoRelations[0].id;
            finalTargetPageId = memoId;
            const memoPropKey = findPropertyKey(entryPage.properties || {}, ["Memorandum", "Memo"]);
            if (memoPropKey) {
              propertiesToUpdate[memoPropKey] = { relation: [{ id: memoId }] };
              debug(`Linked entry to Memorandum page ${memoId} via project relation ${memoPropKey}`);
            }
          } else {
            debug(`Project page ${targetPageId} has no linked Memorandum relation.`);
          }
        }
      }

      // Fetch all blocks from the target page to clone them
      const finalPageObj = await notion.pages.retrieve({ page_id: finalTargetPageId }) as any;
      finalPageObjForFallback = finalPageObj;
      finalTargetPageIdForFallback = finalTargetPageId;

      targetBlocks = await fetchBlocksRecursive(finalTargetPageId);
      if (targetBlocks.length === 0) {
        fallbackMarkdown = buildLinkedPageSummaryMarkdown({
          sourceUrl: chatUrl,
          targetPageId: targetPageId,
          resolvedPageId: finalTargetPageId,
          pageObj: finalPageObj
        });
      }
    } catch (err) {
      warn(`Failed to resolve or link target page from CHAT URL ${chatUrl}:`, err);
      fallbackMarkdown = buildLinkedPageFailureMarkdown({
        sourceUrl: chatUrl,
        targetPageId,
        error: err
      });
    }
  } else if (chatUrl) {
    fallbackMarkdown = buildLinkedPageFailureMarkdown({
      sourceUrl: chatUrl,
      targetPageId: null,
      error: new Error("CHAT URL does not contain a Notion page ID")
    });
  }

  // 3. Sequential numbering name update
  const currentNameProp = findProperty(entryPage.properties || {}, "Name");
  const currentName = currentNameProp?.title?.[0]?.plain_text ?? "";
  if (!/^\d+$/.test(currentName.trim())) {
    const nextNumber = await getNextEntryNumber(projectId, entryId);
    propertiesToUpdate.Name = { title: [{ text: { content: String(nextNumber) } }] };
  }

  await notion.pages.update({
    page_id: entryId,
    properties: propertiesToUpdate,
  });

  // Append cloned blocks if there are any
  if (targetBlocks.length > 0) {
    const blocksToAppend = targetBlocks.map(cleanBlockForAppend).filter(Boolean);
    if (blocksToAppend.length > 0) {
      const CHUNK = 100;
      for (let i = 0; i < blocksToAppend.length; i += CHUNK) {
        await notion.blocks.children.append({
          block_id: entryId,
          children: blocksToAppend.slice(i, i + CHUNK),
        });
      }
      appendedAnyBlocks = true;
      debug(`Copied ${blocksToAppend.length} blocks from target page ${targetPageId} to entry ${entryId}`);
    } else if (!fallbackMarkdown && finalPageObjForFallback && finalTargetPageIdForFallback) {
      fallbackMarkdown = buildLinkedPageSummaryMarkdown({
        sourceUrl: chatUrl,
        targetPageId: targetPageId,
        resolvedPageId: finalTargetPageIdForFallback,
        pageObj: finalPageObjForFallback
      });
    }
  }
  if (!appendedAnyBlocks && fallbackMarkdown) {
    const fallbackBlocks = markdownToRichNotionBlocks(fallbackMarkdown);
    if (fallbackBlocks.length > 0) {
      const CHUNK = 100;
      for (let i = 0; i < fallbackBlocks.length; i += CHUNK) {
        await notion.blocks.children.append({
          block_id: entryId,
          children: fallbackBlocks.slice(i, i + CHUNK) as any,
        });
      }
    }
  }

  debug(`Successfully finished handleChatLink for entry ${entryId}`);
}

function buildLinkedPageFailureMarkdown(input: { sourceUrl: string; targetPageId: string | null; error: unknown }): string {
  const errMsg = input.error instanceof Error ? input.error.message : String(input.error);
  const parts: string[] = [];
  parts.push("# Linked Page");
  parts.push(`- URL: ${input.sourceUrl}`);
  if (input.targetPageId) {
    parts.push(`- Page ID: ${input.targetPageId}`);
  }
  parts.push("");
  parts.push("## Status");
  parts.push(`- Could not fetch/clone page content.`);
  parts.push(`- Error: ${errMsg}`);
  return parts.join("\n");
}

function buildLinkedPageSummaryMarkdown(input: { sourceUrl: string; targetPageId: string | null; resolvedPageId: string; pageObj: any }): string {
  const title = getNotionPageTitle(input.pageObj);
  const parts: string[] = [];
  parts.push("# Linked Page");
  parts.push(`- URL: ${input.sourceUrl}`);
  parts.push(`- Title: ${title}`);
  if (input.targetPageId && input.resolvedPageId !== input.targetPageId) {
    parts.push(`- Resolved Page ID: ${input.resolvedPageId}`);
    parts.push(`- Original Page ID: ${input.targetPageId}`);
  } else if (input.targetPageId) {
    parts.push(`- Page ID: ${input.targetPageId}`);
  } else {
    parts.push(`- Page ID: ${input.resolvedPageId}`);
  }

  const props = input.pageObj?.properties || {};
  const propLines = buildNotionPropertiesSummaryLines(props);
  if (propLines.length > 0) {
    parts.push("");
    parts.push("## Properties");
    parts.push(...propLines.map(l => `- ${l}`));
  }
  return parts.join("\n");
}

function getNotionPageTitle(pageObj: any): string {
  const props = pageObj?.properties || {};
  const keys = Object.keys(props);
  const titleKey = keys.find(k => props[k]?.type === "title") || findPropertyKey(props, ["Name", "Title", "title"]);
  if (!titleKey) return "Untitled";
  const titleParts = props[titleKey]?.title;
  const title = Array.isArray(titleParts) ? richTextToPlain(titleParts) : "";
  return title.trim() || "Untitled";
}

function buildNotionPropertiesSummaryLines(properties: Record<string, any>): string[] {
  const keys = Object.keys(properties || {});
  const lines: string[] = [];
  for (const key of keys) {
    const prop = properties[key];
    if (!prop || typeof prop !== "object") continue;
    if (prop.type === "title") continue;
    const text = notionPropertyToPlainText(prop);
    if (!text) continue;
    lines.push(`${key}: ${text}`);
    if (lines.length >= 50) break;
  }
  return lines;
}

function notionPropertyToPlainText(prop: any): string {
  const type = prop?.type;
  if (!type) return "";
  const val = prop[type];
  if (val === null || val === undefined) return "";

  if (type === "rich_text") return richTextToPlain(val);
  if (type === "title") return richTextToPlain(val);
  if (type === "url") return String(val || "");
  if (type === "email") return String(val || "");
  if (type === "phone_number") return String(val || "");
  if (type === "number") return val === null ? "" : String(val);
  if (type === "checkbox") return val ? "true" : "false";
  if (type === "select") return val?.name ? String(val.name) : "";
  if (type === "status") return val?.name ? String(val.name) : "";
  if (type === "multi_select") return Array.isArray(val) ? val.map((v: any) => v?.name).filter(Boolean).join(", ") : "";
  if (type === "date") return val?.start ? String(val.start) : "";
  if (type === "people") return Array.isArray(val) ? val.map((p: any) => p?.name).filter(Boolean).join(", ") : "";
  if (type === "files") return Array.isArray(val) ? val.map((f: any) => f?.name).filter(Boolean).join(", ") : "";
  if (type === "relation") return Array.isArray(val) ? `${val.length} related` : "";
  if (type === "created_time") return String(val || "");
  if (type === "last_edited_time") return String(val || "");
  if (type === "created_by") return val?.name ? String(val.name) : "";
  if (type === "last_edited_by") return val?.name ? String(val.name) : "";

  if (type === "formula") {
    const formulaType = val?.type;
    if (!formulaType) return "";
    const formulaVal = val[formulaType];
    if (formulaVal === null || formulaVal === undefined) return "";
    if (formulaType === "string") return String(formulaVal);
    if (formulaType === "number") return String(formulaVal);
    if (formulaType === "boolean") return formulaVal ? "true" : "false";
    if (formulaType === "date") return formulaVal?.start ? String(formulaVal.start) : "";
    return "";
  }

  if (type === "rollup") {
    const rollType = val?.type;
    if (!rollType) return "";
    if (rollType === "number") return val?.number === null ? "" : String(val.number);
    if (rollType === "date") return val?.date?.start ? String(val.date.start) : "";
    if (rollType === "array") return Array.isArray(val?.array) ? `${val.array.length} items` : "";
    return "";
  }

  return "";
}

function richTextToPlain(richText: any[]): string {
  if (!Array.isArray(richText)) return "";
  return richText
    .map(rt => rt?.plain_text ?? rt?.text?.content ?? "")
    .filter(Boolean)
    .join("");
}

function extractFirstUrl(text: string): string | null {
  if (!text) return null;
  const match = text.match(/https?:\/\/[^\s<>"'`]+/i);
  return match ? match[0] : null;
}

function normalizeNotionUrl(url: string): string {
  if (!url) return "";
  let u = String(url).trim();
  u = u.replace(/^`+/, "").replace(/`+$/, "");
  u = u.replace(/^[<("']+/, "").replace(/[>)"']+$/, "");
  return u.trim();
}

function cleanBlockForAppend(block: any): any {
  const type = block.type;
  if (!type) return null;

  if (type === "child_page" && block.id) {
    return {
      object: "block",
      type: "link_to_page",
      link_to_page: {
        type: "page_id",
        page_id: String(block.id)
      }
    };
  }

  if (type === "child_database" && block.id) {
    return {
      object: "block",
      type: "link_to_page",
      link_to_page: {
        type: "database_id",
        database_id: String(block.id)
      }
    };
  }

  const WRITABLE_TYPES = new Set([
    "paragraph",
    "heading_1",
    "heading_2",
    "heading_3",
    "bulleted_list_item",
    "numbered_list_item",
    "to_do",
    "toggle",
    "embed",
    "image",
    "video",
    "file",
    "pdf",
    "bookmark",
    "callout",
    "quote",
    "equation",
    "divider",
    "table_of_contents",
    "column",
    "column_list",
    "link_to_page",
    "synced_block",
    "template",
    "code",
    "table",
    "table_row"
  ]);

  if (!WRITABLE_TYPES.has(type)) {
    return null;
  }

  const content = block[type];
  if (!content) return null;

  const cleanContent = stripNulls({ ...content });
  if (cleanContent.rich_text) {
    cleanContent.rich_text = sanitizeRichText(cleanContent.rich_text);
  }

  const result: any = {
    object: "block",
    type,
    [type]: cleanContent
  };

  if (block.children && block.children.length > 0) {
    const cleanChildren = block.children.map(cleanBlockForAppend).filter(Boolean);
    if (cleanChildren.length > 0) {
      result[type].children = cleanChildren;
    }
  }

  // A table requires children to be valid when creating
  if (type === "table" && (!result[type].children || result[type].children.length === 0)) {
    return null;
  }

  return result;
}

function stripNulls(obj: any): any {
  if (obj === null) return undefined;
  if (Array.isArray(obj)) {
    return obj.map(stripNulls);
  }
  if (typeof obj === "object") {
    const clean: Record<string, any> = {};
    for (const key of Object.keys(obj)) {
      const val = stripNulls(obj[key]);
      if (val !== undefined) {
        clean[key] = val;
      }
    }
    return clean;
  }
  return obj;
}

function extractNotionPageId(url: string): string | null {
  if (!url) return null;
  const cleanUrl = url.split(/[?#]/)[0];
  const match = cleanUrl.match(/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i) || 
                cleanUrl.match(/[0-9a-f]{32}/i);
  if (match) {
    return match[0].replace(/-/g, "").toLowerCase();
  }
  return null;
}

function findPropertyKey(properties: Record<string, any>, possibilities: string[]): string | undefined {
  const keys = Object.keys(properties);
  for (const pos of possibilities) {
    const target = pos.toLowerCase().replace(/\s+/g, "");
    const match = keys.find(k => k.toLowerCase().replace(/\s+/g, "") === target);
    if (match) return match;
  }
  return undefined;
}
