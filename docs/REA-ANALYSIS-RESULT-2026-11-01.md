# REA analysis result — 2026-11-02

**Target:** recovered CIEL production Worker bundle in `reconstructed/`  
**Tool:** [Reverse Engineer Anything — JavaScript application analyzer](https://github.com/morluto/rea)  
**GitLab job:** [REA analysis job 17649637023](https://gitlab.com/leno3z4rrrri/ciel2/-/jobs/17649637023)  
**Evidence ID:** `ev_71c5f0a1acec9df75cbe1bef3e9984a2578056520dea2b701e353e77bf130793`  
**Analyzed directory digest:** `41b2f79f1f2a963d642b0f3f3a8eb67cf17006e9c9914edf4d3742f2bd32a004`  
**Authority:** shipped artifact; confidence: derived.

## Analysis result

REA successfully processed seven JavaScript files (six recovered module sections plus the complete reassembled Worker):

- Text read: 419,239 bytes
- Parsed JavaScript files: 7
- Skipped JavaScript files: 0
- AST nodes visited: 66,209
- Findings: 216
- Parse failures: 0
- Application graph: 134 nodes, 230 edges
- Graph node kinds: 97 endpoint nodes, 27 JavaScript module nodes, 7 JavaScript asset nodes, 2 source-map nodes, 1 artifact node
- Semantic graph: 41,099 nodes

The zero browser-window, Electron IPC, preload and native-addon counts are expected: CIEL is a Cloudflare Worker, not an Electron desktop app.

The exact reconstructed Worker is 209,745 characters with SHA-256 `24e6452b4a2854a1e37f864adcb201d588771460eed68bcd100f5cfbafd564b6`. That bundle digest is independently checked by the GitLab recovery verification job.

## Important limitations

- The `src/index.js` fragment was marked partial because REA recovered from script parsing errors. The complete `worker.js` artifact was marked complete, and GitLab CI independently passed Node syntax validation for that complete bundle.
- REA's route inventory contained zero route patterns and zero occurrences. Its route coverage was explicitly `unknown`. Do not use this as evidence that CIEL has no HTTP routes. The actual HTTP routes were recovered separately by inspecting the deployed `index.js` request handler.
- Prior point-in-time endpoint snapshots recorded HTTP 200 for `/health`, `/api/signals`, and `/api/research`; they are not fresh smoke tests from this audit.
- Two interpretation unknowns concerned navigation destinations that were not supported literal paths. These do not establish a missing endpoint.
- REA analyzes the shipped JavaScript statically and did not execute the Worker or its bundle bootstrap.
- Static imports, endpoints, storage relationships and graph edges do not prove runtime reachability or execution.

## Practical conclusion

REA supplied an additional structural inventory of the shipped artifact and a semantic graph. It did not replace source-level inspection of Cloudflare Worker request handling, the live Cloudflare resource inventory, or runtime tests.

A separate REA pass on the tier-patched staging candidate has completed. See `docs/REA-PATCHED-ANALYSIS-2026-11-02.md`; it must remain separate from this recovered-production-bundle report.

The full REA JSON report and concise summary are available in the GitLab job artifacts for 30 days. The report is intentionally not committed as an 11 MB repository file.
