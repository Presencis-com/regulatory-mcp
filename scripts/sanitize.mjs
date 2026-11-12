/**
 * Public-text cleanup for compliance questions.
 * Drops product-capability paragraphs and fixes one known corpus typo.
 * Retired framework ids are removed from regulation lists and refused in kept text.
 */
const RETIRED_IDS = Object.freeze([
  "ru-149fz",
  "ru-152fz",
  "ru-242fz",
  "ru-ai-framework",
  "ru-gost-crypto",
  "ru-rkn",
]);

const PROPRIETARY = /\b(aegis|equivalence shape|samd triangle)\b/i;

export function sanitizeText(value) {
  if (typeof value !== "string") {
    throw new Error("sanitizeText expected a string");
  }
  const fixed = value.replaceAll("chain5797", "chain");
  const kept = fixed
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph.trim() && !PROPRIETARY.test(paragraph));
  return kept.join("\n\n").trim();
}

export function assertNoRetired(value, label) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const id of RETIRED_IDS) {
    if (text.includes(id)) {
      throw new Error(`retired framework id in ${label}: ${id}`);
    }
  }
}

export function regulationList(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} regulations field is empty`);
  }
  const out = [];
  for (const part of value.split(",")) {
    const id = part.trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      throw new Error(`${label} malformed regulation id: ${JSON.stringify(id)}`);
    }
    if (id.startsWith("ru-") || RETIRED_IDS.includes(id)) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export { RETIRED_IDS };
