/**
 * Build data/corpus-snapshot.json from the crosswalk package output plus
 * the public English question files under PRESENCIS_CORPUS_ROOT.
 *
 * CROSSWALKS_DATA must be the directory that contains frameworks.json,
 * sectors.json, and crosswalks.json. No network. Refuses retired ids.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assertNoRetired, regulationList, sanitizeText } from "./sanitize.mjs";

function fail(message) {
  throw new Error(message);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) fail(`${name} is unset`);
  return value;
}

function normalize(text) {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function parseFrontmatter(text, filePath) {
  if (!text.startsWith("---\n")) fail(`missing frontmatter: ${filePath}`);
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) fail(`unclosed frontmatter: ${filePath}`);
  const fields = {};
  for (const line of text.slice(4, end).split("\n")) {
    if (!line.trim()) continue;
    const cut = line.indexOf(":");
    if (cut <= 0) fail(`frontmatter line has no key: ${filePath}`);
    let decoded;
    try {
      decoded = JSON.parse(line.slice(cut + 1).trim());
    } catch (err) {
      fail(`frontmatter value is not JSON (${line.slice(0, cut)}) in ${filePath}: ${err.message}`);
    }
    if (typeof decoded !== "string") fail(`frontmatter value is not a string in ${filePath}`);
    fields[line.slice(0, cut).trim()] = decoded;
  }
  return { fields, body: text.slice(end + 5) };
}

function section(body, title) {
  // No multiline flag: `$` must mean end of string, not end of line.
  const match = body.match(new RegExp(`(?:^|\\n)## ${title}\\n([\\s\\S]*?)(?=\\n## |$)`));
  return match ? match[1].trim() : null;
}

function articles(text) {
  if (!text) return [];
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => sanitizeText(line.slice(2).replaceAll("**", "").trim()))
    .filter(Boolean);
}

export function loadQuestions(corpusRoot) {
  const dir = join(corpusRoot, "apps/web/content/questions/en");
  const names = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
  const questions = [];
  for (const name of names) {
    const filePath = join(dir, name);
    const { fields, body } = parseFrontmatter(normalize(readFileSync(filePath, "utf8")), filePath);
    const slug = name.replace(/\.md$/, "");
    if (fields.slug !== slug) fail(`slug mismatch in ${name}: ${fields.slug}`);
    const question = sanitizeText(fields.question);
    const answer = sanitizeText(fields.answer);
    const shortAnswer = sanitizeText(section(body, "Short Answer") || "");
    const detailed = sanitizeText(section(body, "Detailed Explanation") || "");
    if (!question || !answer || !shortAnswer || !detailed) {
      fail(`empty public field in ${name}`);
    }
    const record = {
      slug,
      question,
      answer,
      shortAnswer,
      category: fields.category,
      regulations: regulationList(fields.regulations, name),
      relevantArticles: articles(section(body, "Relevant Articles")),
      canonicalUrl: `https://presencis.com/questions/${slug}/`,
    };
    if (typeof record.category !== "string" || !record.category.trim()) {
      fail(`empty category in ${name}`);
    }
    assertNoRetired(record, name);
    questions.push(record);
  }
  if (questions.length !== 360) fail(`expected 360 questions, found ${questions.length}`);
  return questions;
}

export function loadCrosswalkData(dataDir) {
  const frameworks = JSON.parse(readFileSync(join(dataDir, "frameworks.json"), "utf8"));
  const sectors = JSON.parse(readFileSync(join(dataDir, "sectors.json"), "utf8"));
  const crosswalks = JSON.parse(readFileSync(join(dataDir, "crosswalks.json"), "utf8"));
  if (!Array.isArray(frameworks) || frameworks.length !== 95) {
    fail(`expected 95 frameworks, found ${Array.isArray(frameworks) ? frameworks.length : "not-an-array"}`);
  }
  assertNoRetired({ frameworks, sectors, crosswalks }, "crosswalk data");
  return { frameworks, sectors, crosswalks };
}

function snapshotText(snapshot) {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

export function buildSnapshot(options) {
  const questions = loadQuestions(options.corpusRoot);
  const crosswalks = loadCrosswalkData(options.crosswalksData);
  const snapshot = { ...crosswalks, questions };
  const text = snapshotText(snapshot);
  assertNoRetired(text, "snapshot");
  mkdirSync(dirname(options.outFile), { recursive: true });
  writeFileSync(options.outFile, text);
  return { frameworks: snapshot.frameworks.length, questions: questions.length };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const stats = buildSnapshot({
      corpusRoot: requiredEnv("PRESENCIS_CORPUS_ROOT"),
      crosswalksData: requiredEnv("CROSSWALKS_DATA"),
      outFile: join(here, "..", "data", "corpus-snapshot.json"),
    });
    process.stdout.write(`frameworks ${stats.frameworks} questions ${stats.questions}\n`);
  } catch (err) {
    process.stderr.write(`sync-corpus: ${err.message}\n`);
    process.exit(1);
  }
}
