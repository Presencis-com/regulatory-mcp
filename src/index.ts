#!/usr/bin/env node
/**
 * Read-only stdio MCP server. Loads a built snapshot. No network. No writes.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { getHealthGatewayInput, listHealthGatewaysInput, loadHealthGateways } from "./health-data-gateways.js";

type Framework = {
  id: string;
  name: string;
  officialName: string;
  shortName: string;
  jurisdiction: string;
  status: string;
  effectiveDate: string | null;
  authority: string | null;
  officialText: string | null;
  wikidataQid: string | null;
  sectors: string[];
  canonicalUrl: string;
};

type Sector = {
  id: string;
  label: string;
  description: string;
  regulations: string[];
};

type Comparison = {
  id: string;
  sourceId: string;
  targetId: string;
  title: string;
  summary: string;
  canonicalUrl: string;
};

type Overlap = {
  sourceId: string;
  targetId: string;
  sectors: string[];
};

type Question = {
  slug: string;
  question: string;
  answer: string;
  shortAnswer: string;
  category: string;
  regulations: string[];
  relevantArticles: string[];
  canonicalUrl: string;
};

type Snapshot = {
  frameworks: Framework[];
  sectors: Sector[];
  crosswalks: { comparisons: Comparison[]; sectorCooccurrence: Overlap[] };
  questions: Question[];
};

const RETIRED = ["ru-149fz", "ru-152fz", "ru-242fz", "ru-ai-framework", "ru-gost-crypto", "ru-rkn"];
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function die(message: string): never {
  process.stderr.write(`regulatory-mcp: ${message}\n`);
  process.exit(1);
}

function loadSnapshot(): Snapshot {
  const path = join(dirname(fileURLToPath(import.meta.url)), "../data/corpus-snapshot.json");
  let parsed: Snapshot;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
  } catch (err) {
    die(`snapshot unreadable: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed.frameworks) || parsed.frameworks.length !== 95) {
    die("snapshot frameworks length is not 95");
  }
  if (!Array.isArray(parsed.questions) || parsed.questions.length !== 360) {
    die("snapshot questions length is not 360");
  }
  const blob = JSON.stringify(parsed);
  for (const id of RETIRED) {
    if (blob.includes(id)) die(`snapshot contains retired id ${id}`);
  }
  return parsed;
}

const snapshot = loadSnapshot();
const healthGateways = loadHealthGateways();
const frameworks = new Map(snapshot.frameworks.map((item) => [item.id, item]));
const sectors = new Map(snapshot.sectors.map((item) => [item.id, item]));
const jurisdictions = new Set(snapshot.frameworks.map((item) => item.jurisdiction));

function inputSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

const listInput = z.object({
  jurisdiction: z.string().min(1).optional(),
  sector: z.string().min(1).optional(),
}).strict();

const getInput = z.object({ id: z.string().min(1) }).strict();

const crossInput = z.object({
  source_id: z.string().min(1),
  target_id: z.string().min(1).optional(),
}).strict();

const searchInput = z.object({
  query: z.string().min(1).max(500),
  regulation: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(25).optional(),
}).strict();

const sectorInput = z.object({ sector: z.string().min(1) }).strict();

const tools = [
  {
    name: "list_frameworks",
    description: "List active regulatory frameworks. Optional exact filters: jurisdiction, sector id.",
    inputSchema: inputSchema(listInput),
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_framework",
    description: "Fetch one active framework by exact id, including related comparisons and sector overlaps.",
    inputSchema: inputSchema(getInput),
    annotations: { readOnlyHint: true },
  },
  {
    name: "find_crosswalk",
    description: "Find comparison summaries and sector overlaps for an active source id, optionally one target id.",
    inputSchema: inputSchema(crossInput),
    annotations: { readOnlyHint: true },
  },
  {
    name: "search_compliance_qa",
    description: "Rank public compliance questions. Returns canonical https://presencis.com/questions/<slug>/ links.",
    inputSchema: inputSchema(searchInput),
    annotations: { readOnlyHint: true },
  },
  {
    name: "map_sector_obligations",
    description: "List active frameworks mapped to a sector and the published sector description. Does not invent article-level duties.",
    inputSchema: inputSchema(sectorInput),
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_health_data_gateways",
    description: "List public atlas entries with optional exact jurisdiction and secure-environment filters.",
    inputSchema: inputSchema(listHealthGatewaysInput),
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_health_data_gateway",
    description: "Get a public health data atlas entry and its official citations by exact gateway id.",
    inputSchema: inputSchema(getHealthGatewayInput),
    annotations: { readOnlyHint: true },
  },
];

function fail(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function parse<T>(schema: z.ZodType<T>, value: unknown): { ok: true; data: T } | { ok: false; message: string } {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) return { ok: false, message: "invalid arguments" };
  return { ok: true, data: parsed.data };
}

function frameworkRef(id: string): { error: string } | { framework: Framework } {
  if (!ID_RE.test(id)) return { error: `malformed framework id: ${id}` };
  if (id.startsWith("ru-") || RETIRED.includes(id)) return { error: `retired framework id: ${id}` };
  const framework = frameworks.get(id);
  if (!framework) return { error: `unknown framework id: ${id}` };
  return { framework };
}

function comparisonsFor(sourceId: string, targetId?: string): Comparison[] {
  return snapshot.crosswalks.comparisons.filter((item) => {
    const hit = item.sourceId === sourceId || item.targetId === sourceId;
    if (!hit) return false;
    if (!targetId) return true;
    return item.sourceId === targetId || item.targetId === targetId;
  });
}

function overlapsFor(sourceId: string, targetId?: string): Overlap[] {
  return snapshot.crosswalks.sectorCooccurrence.filter((item) => {
    const ids = [item.sourceId, item.targetId];
    if (!ids.includes(sourceId)) return false;
    if (!targetId) return true;
    return ids.includes(targetId);
  });
}

function tokensOf(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 2))];
}

function scoreQuestion(question: Question, tokens: string[]): number {
  const questionText = question.question.toLowerCase();
  const shortText = question.shortAnswer.toLowerCase();
  const answerText = question.answer.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (questionText.includes(token)) score += 3;
    if (shortText.includes(token)) score += 2;
    if (answerText.includes(token)) score += 1;
  }
  return score;
}

function callTool(name: string, args: unknown) {
  if (name === "list_frameworks") {
    const parsed = parse(listInput, args);
    if (!parsed.ok) return fail(parsed.message);
    const { jurisdiction, sector } = parsed.data;
    if (jurisdiction && !jurisdictions.has(jurisdiction)) return fail(`unknown jurisdiction: ${jurisdiction}`);
    if (sector && !sectors.has(sector)) return fail(`unknown sector: ${sector}`);
    const items = snapshot.frameworks.filter((item) => {
      if (jurisdiction && item.jurisdiction !== jurisdiction) return false;
      if (sector && !item.sectors.includes(sector)) return false;
      return true;
    });
    return ok({ count: items.length, frameworks: items });
  }
  if (name === "get_framework") {
    const parsed = parse(getInput, args);
    if (!parsed.ok) return fail(parsed.message);
    const ref = frameworkRef(parsed.data.id);
    if ("error" in ref) return fail(ref.error);
    return ok({
      framework: ref.framework,
      comparisons: comparisonsFor(ref.framework.id),
      sectorOverlaps: overlapsFor(ref.framework.id),
    });
  }
  if (name === "find_crosswalk") {
    const parsed = parse(crossInput, args);
    if (!parsed.ok) return fail(parsed.message);
    const source = frameworkRef(parsed.data.source_id);
    if ("error" in source) return fail(source.error);
    let targetId: string | undefined;
    if (parsed.data.target_id) {
      const target = frameworkRef(parsed.data.target_id);
      if ("error" in target) return fail(target.error);
      if (target.framework.id === source.framework.id) return fail("target_id must differ from source_id");
      targetId = target.framework.id;
    }
    return ok({
      sourceId: source.framework.id,
      targetId: targetId ?? null,
      comparisons: comparisonsFor(source.framework.id, targetId),
      sectorOverlaps: overlapsFor(source.framework.id, targetId),
    });
  }
  if (name === "search_compliance_qa") {
    const parsed = parse(searchInput, args);
    if (!parsed.ok) return fail(parsed.message);
    const tokens = tokensOf(parsed.data.query);
    if (tokens.length === 0) return fail("query has no searchable terms");
    if (parsed.data.regulation) {
      const ref = frameworkRef(parsed.data.regulation);
      if ("error" in ref) return fail(ref.error);
    }
    const regulation = parsed.data.regulation;
    const ranked = snapshot.questions
      .filter((item) => (regulation ? item.regulations.includes(regulation) : true))
      .map((item) => ({ item, score: scoreQuestion(item, tokens) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.item.slug.localeCompare(b.item.slug))
      .slice(0, parsed.data.limit ?? 10)
      .map(({ item, score }) => ({
        slug: item.slug,
        question: item.question,
        shortAnswer: item.shortAnswer,
        category: item.category,
        regulations: item.regulations,
        canonicalUrl: item.canonicalUrl,
        score,
      }));
    return ok({ count: ranked.length, results: ranked });
  }
  if (name === "map_sector_obligations") {
    const parsed = parse(sectorInput, args);
    if (!parsed.ok) return fail(parsed.message);
    const sector = sectors.get(parsed.data.sector);
    if (!sector) return fail(`unknown sector: ${parsed.data.sector}`);
    const items = sector.regulations.map((id) => {
      const framework = frameworks.get(id);
      if (!framework) die(`sector ${sector.id} cites missing framework ${id}`);
      return {
        id: framework.id,
        name: framework.name,
        officialName: framework.officialName,
        canonicalUrl: framework.canonicalUrl,
      };
    });
    return ok({
      sector: sector.id,
      label: sector.label,
      description: sector.description,
      frameworks: items,
      obligationsSummary: `${sector.description} Active frameworks: ${items.map((item) => item.officialName).join("; ")}.`,
    });
  }
  if (name === "list_health_data_gateways") {
    const parsed = parse(listHealthGatewaysInput, args);
    if (!parsed.ok) return fail(parsed.message);
    const { jurisdiction } = parsed.data;
    if (jurisdiction !== undefined && !healthGateways.hasJurisdiction(jurisdiction)) {
      return fail(`unknown jurisdiction: ${jurisdiction}`);
    }
    const gateways = healthGateways.list(parsed.data);
    return ok({ count: gateways.length, gateways });
  }
  if (name === "get_health_data_gateway") {
    const parsed = parse(getHealthGatewayInput, args);
    if (!parsed.ok) return fail(parsed.message);
    const id = parsed.data.gateway_id;
    const gateway = healthGateways.get(id);
    if (!gateway) return fail(`unknown gateway id: ${id}`);
    return ok({ gateway });
  }
  return fail(`unknown tool: ${name}`);
}

const server = new Server(
  { name: "regulatory-mcp", version: "1.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  return callTool(request.params.name, request.params.arguments);
});

const transport = new StdioServerTransport();
await server.connect(transport);
