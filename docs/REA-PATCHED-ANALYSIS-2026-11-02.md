# REA analysis of patched CIEL staging candidate — 2026-11-02

## Run

- GitLab project: 88353316
- Branch: audit/paper-trading-fix
- Pipeline: 3015716419
- REA job: 17650240840
- Candidate: reconstructed/patched-worker.js
- Job status: success
- Artifact: 5.2 MB REA job artifact, retained until 2026-12-02

## Static analysis result

- Parsed JavaScript files: 1 (the complete bundled Worker candidate)
- Source parsing: complete
- Visited AST nodes: 33,200
- Findings: 108
- Parse failures: 0
- Invalid UTF-8 files: 0
- Graph: 62 nodes, 110 edges
- Graph node kinds: 48 endpoint nodes, 11 JavaScript-module nodes, 1 source-map node, 1 artifact node, 1 JavaScript-asset node
- Semantic graph: reached its 20,000-node cap; edge count unavailable
- Integrity contradictions: 0

## Coverage limitations

The REA output explicitly reports:
- candidate enumeration: partial
- application routes: unknown
- route patterns: 0
- route occurrences: 0
- capacity: unknown

The only route-inventory source was the bundled worker.js asset. The route inventory returned no static route candidates and one unknown navigation destination at source line 2452. Its limitations state that reachability, permissions, server-only routes and the complete application route set are unverified.

This is not evidence that the Worker has no routes. It means this REA route-inventory pass could not infer them from the bundled source. The live read-only smoke test separately verified 14 actual GET routes. POST Telegram webhook handling and live callback clicks remain untested.

## Findings interpretation

The 108 findings are REA static-analysis findings. The run completed without parse failures and reported no integrity contradictions, but this summary does not classify all 108 findings by severity or prove that they are all actionable defects. The job artifact contains the complete machine output and should be reviewed before production deployment.

The earlier REA pass on the recovered production bundle analyzed seven parsed JavaScript fragments/files, 66,209 AST nodes, 216 findings and zero parse failures. The two reports have different scopes and should not be compared as if the finding count were a quality score.

## Companion validation

The same pipeline individually passed:
- exact recovered bundle reconstruction: 209,745 bytes, SHA-256 24e6452b4a2854a1e37f864adcb201d588771460eed68bcd100f5cfbafd564b6;
- staging patch application and syntax check;
- paper behavior tests for 50x/100x entries, margin tiers, P&L, stop/target/max-hold/profit-protection exits, equity reconciliation and entry guards;
- case-preserving Hyperliquid order-book fallback patch assertions;
- staging resource isolation checks;
- live LeverUp market metadata verification;
- 14-route read-only production Worker smoke test.

GitLab's top-level pipeline status reported failed even though every listed job reported success. That status inconsistency remains unexplained; do not merge based on job status alone.

**Conclusion:** REA parsing completed cleanly, but route inventory and semantic graph coverage are incomplete. Use the live smoke test and source-specific tests as complementary evidence; do not call the production audit complete solely because REA returned success.
