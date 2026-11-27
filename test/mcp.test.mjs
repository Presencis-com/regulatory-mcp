import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertNoRetired, regulationList, sanitizeText } from "../scripts/sanitize.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "dist", "index.js");

function findAuditScript(start) {
  let cursor = start;
  for (let i = 0; i < 8; i++) {
    const candidate = join(cursor, "scripts", "audit-public-ip.mjs");
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  return null;
}

function startServer() {
  const child = spawn(process.execPath, [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const pending = [];
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.shift();
      if (!waiter) throw new Error(`unexpected server message: ${line.slice(0, 200)}`);
      waiter.resolve(message);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  let nextId = 1;
  function request(method, params) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout ${method}; stderr=${stderr}`)), 8000);
      pending.push({
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  }
  function notify(method) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }
  return {
    stderr: () => stderr,
    request,
    notify,
    close() {
      child.kill("SIGTERM");
    },
  };
}

function toolText(message) {
  assert.equal(message.error, undefined, JSON.stringify(message.error));
  const result = message.result;
  assert.ok(result);
  assert.equal(result.isError, undefined);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

function toolError(message) {
  assert.equal(message.error, undefined, JSON.stringify(message.error));
  assert.equal(message.result.isError, true);
  return message.result.content[0].text;
}

test("sanitizer fixes the corpus typo and drops capability paragraphs", () => {
  assert.equal(sanitizeText("audit chain5797 end"), "audit chain end");
  assert.equal(
    sanitizeText("Public rule.\n\nAegis tracks an internal graph.\n\nNext rule."),
    "Public rule.\n\nNext rule.",
  );
  assert.deepEqual(regulationList("gdpr, ru-152fz, hipaa", "fixture"), ["gdpr", "hipaa"]);
  assert.throws(() => assertNoRetired("mentions ru-152fz", "fixture"), /retired framework id/);
  assert.throws(() => regulationList("NOT ID", "fixture"), /malformed regulation id/);
});

test("stdio MCP serves seven read-only tools and rejects bad ids", async () => {
  const client = startServer();
  try {
    const init = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "regulatory-mcp-test", version: "1.0.0" },
    });
    assert.equal(init.result.serverInfo.name, "regulatory-mcp");
    client.notify("notifications/initialized");
    const listed = await client.request("tools/list", {});
    const names = listed.result.tools.map((tool) => tool.name);
    assert.deepEqual(names, [
      "list_frameworks",
      "get_framework",
      "find_crosswalk",
      "search_compliance_qa",
      "map_sector_obligations",
      "list_health_data_gateways",
      "get_health_data_gateway",
    ]);

    const all = toolText(await client.request("tools/call", { name: "list_frameworks", arguments: {} }));
    assert.equal(all.count, 95);
    assert.ok(all.frameworks.some((item) => item.id === "gdpr"));
    assert.equal(JSON.stringify(all).includes("ru-152fz"), false);

    const eu = toolText(await client.request("tools/call", {
      name: "list_frameworks",
      arguments: { jurisdiction: "EU" },
    }));
    assert.ok(eu.count > 0);
    assert.ok(eu.frameworks.every((item) => item.jurisdiction === "EU"));
    assert.match(toolError(await client.request("tools/call", {
      name: "list_frameworks",
      arguments: { jurisdiction: "Atlantis" },
    })), /unknown jurisdiction/);

    const gdpr = toolText(await client.request("tools/call", {
      name: "get_framework",
      arguments: { id: "gdpr" },
    }));
    assert.equal(gdpr.framework.canonicalUrl, "https://presencis.com/regulations/gdpr/");
    assert.equal(gdpr.framework.wikidataQid, "Q1172506");
    assert.match(toolError(await client.request("tools/call", {
      name: "get_framework",
      arguments: { id: "ru-152fz" },
    })), /retired framework id/);
    assert.match(toolError(await client.request("tools/call", {
      name: "get_framework",
      arguments: { id: "not-a-real-framework" },
    })), /unknown framework id/);
    assert.match(toolError(await client.request("tools/call", {
      name: "get_framework",
      arguments: { id: "gdpr", extra: true },
    })), /invalid arguments/);
    assert.match(toolError(await client.request("tools/call", {
      name: "get_framework",
      arguments: {},
    })), /invalid arguments/);

    const cross = toolText(await client.request("tools/call", {
      name: "find_crosswalk",
      arguments: { source_id: "ccpa", target_id: "hipaa" },
    }));
    assert.ok(cross.comparisons.some((item) => item.canonicalUrl === "https://presencis.com/regulations/comparisons/ccpa-vs-hipaa/"));
    assert.match(toolError(await client.request("tools/call", {
      name: "find_crosswalk",
      arguments: { source_id: "gdpr", target_id: "ru-152fz" },
    })), /retired framework id/);

    const found = toolText(await client.request("tools/call", {
      name: "search_compliance_qa",
      arguments: { query: "medical device", regulation: "mdr", limit: 5 },
    }));
    assert.ok(found.count >= 1);
    assert.ok(found.count <= 5);
    for (const item of found.results) {
      assert.equal(item.canonicalUrl, `https://presencis.com/questions/${item.slug}/`);
      assert.ok(item.regulations.includes("mdr"));
    }
    const empty = toolText(await client.request("tools/call", {
      name: "search_compliance_qa",
      arguments: { query: "zzzzqqqq" },
    }));
    assert.equal(empty.count, 0);
    assert.match(toolError(await client.request("tools/call", {
      name: "search_compliance_qa",
      arguments: { query: " " },
    })), /invalid arguments|no searchable terms/);
    assert.match(toolError(await client.request("tools/call", {
      name: "search_compliance_qa",
      arguments: { query: "gdpr", limit: 0 },
    })), /invalid arguments/);

    const sector = toolText(await client.request("tools/call", {
      name: "map_sector_obligations",
      arguments: { sector: "healthcare" },
    }));
    assert.equal(sector.sector, "healthcare");
    assert.ok(sector.frameworks.some((item) => item.id === "gdpr"));
    assert.match(sector.obligationsSummary, /Active frameworks:/);
    assert.match(toolError(await client.request("tools/call", {
      name: "map_sector_obligations",
      arguments: { sector: "nope" },
    })), /unknown sector/);
  } finally {
    client.close();
  }
});

test("public tree has zero IP-audit findings", { skip: !findAuditScript(ROOT) && "external staging audit script not present" }, () => {
  const script = findAuditScript(ROOT);
  const run = spawnSync(process.execPath, [script, ROOT], { encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});
