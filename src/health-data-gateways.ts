import { readFileSync } from "node:fs";
import { z } from "zod";

const gatewayID = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)+$/);
const text = z.string().min(1);
const gateway = z.object({
  gateway_id: gatewayID,
  jurisdiction: text,
  authority_name: text,
  route_type: z.enum(["research-access", "device-evidence", "privacy-rule"]),
  legal_basis: text,
  ai_secondary_use_scope: text,
  spe_or_sde_required: z.boolean(),
  required_application_evidence: z.array(text).min(1),
  subgroup_or_bias_evidence_expected: z.boolean(),
  disclosure_control_expected: z.boolean(),
  key_milestones_or_timelines: text,
  official_source_urls: z.array(z.url({ protocol: /^https$/ })).min(1),
  presencis_canonical_url: z.url({ protocol: /^https$/, hostname: /^presencis\.com$/ }),
}).strict();

export const listHealthGatewaysInput = z.object({
  jurisdiction: text.optional(),
  spe_or_sde_required: z.boolean().optional(),
}).strict();

export const getHealthGatewayInput = z.object({ gateway_id: gatewayID }).strict();

export function loadHealthGateways() {
  const path = new URL("../data/health-data-gateways.json", import.meta.url);
  const rows = z.array(gateway).min(1).parse(JSON.parse(readFileSync(path, "utf8")));
  const byID = new Map(rows.map(row => [row.gateway_id, row]));
  if (byID.size !== rows.length) throw new Error("duplicate health data gateway id");
  const jurisdictions = new Set(rows.map(row => row.jurisdiction));

  return {
    get: (id: string) => byID.get(id),
    hasJurisdiction: (name: string) => jurisdictions.has(name),
    list: ({ jurisdiction, spe_or_sde_required }: z.infer<typeof listHealthGatewaysInput>) =>
      rows.filter(row =>
        (jurisdiction === undefined || row.jurisdiction === jurisdiction) &&
        (spe_or_sde_required === undefined || row.spe_or_sde_required === spe_or_sde_required),
      ),
  };
}
