import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const input = process.argv[2] || path.resolve(here, "../rea-analysis.json");
const output = path.resolve(here, "../rea-summary.json");
const evidence = JSON.parse(await readFile(input, "utf8"));
const result = evidence.normalized_result || {};
const graph = result.graph || {};
const semantic = result.semantic_graph || {};
const countBy = (items, key) => (items || []).reduce((acc, item) => {
  const value = item?.[key] || "unknown";
  acc[value] = (acc[value] || 0) + 1;
  return acc;
}, {});
const summary = {
  evidence_id: evidence.evidence_id,
  subject: evidence.subject,
  provider: evidence.provider,
  predicate_type: evidence.predicate_type,
  confidence: evidence.confidence,
  authority: evidence.authority,
  relationship_coverage: evidence.relationship_coverage,
  summary: result.summary,
  statistics: result.statistics,
  graph: {
    root_node_ids: graph.root_node_ids,
    node_count: graph.nodes?.length ?? null,
    edge_count: graph.edges?.length ?? null,
    node_kinds: countBy(graph.nodes, "kind"),
    edge_kinds: countBy(graph.edges, "kind")
  },
  semantic_graph: {
    keys: Object.keys(semantic),
    node_count: semantic.nodes?.length ?? null,
    edge_count: semantic.edges?.length ?? null
  },
  route_inventory: result.route_inventory,
  integrity_contradictions: result.integrity_contradictions,
  limitations: result.limitations
};
await writeFile(output, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
