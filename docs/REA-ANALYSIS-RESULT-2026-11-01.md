# REA analysis result — 2026-11-01

**Target:** reconstructed CIEL Worker bundle  
**Tool:** [Reverse Engineer Anything — JavaScript application analyzer](https://github.com/morluto/rea)  
**GitLab job:** [REA analysis job 17642231044](https://gitlab.com/leno3z4-group/leno3z4-project/-/jobs/17642231044)  
**Evidence ID:** `ev_189024d24dc153f787606de918e5ed7e9435fb0b359f552bf030ce790de71ce2`  
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
- Integrity contradictions: none

The zero browser-window, Electron IPC, preload and native-addon counts are expected: CIEL is a Cloudflare Worker, not an Electron desktop app.

## Important limitations

- The `src/index.js` fragment was marked partial because REA recovered from script parsing errors. The complete `worker.js` artifact was marked complete, and the GitLab CI check independently passed Node syntax validation for that complete bundle.
- REA's route inventory contained zero route patterns and zero occurrences. Its route coverage was explicitly `unknown`. Do not use this as evidence that CIEL has no HTTP routes. The actual HTTP routes were recovered separately by inspecting `src/index.ts` and checking the live Worker endpoints.
- Two interpretation unknowns concerned navigation destinations that were not supported literal paths. These do not establish a missing endpoint.
- REA analyzes the shipped JavaScript statically and did not execute the Worker or its bundle bootstrap.
- Static imports, endpoints, storage relationships and graph edges do not prove runtime reachability or execution.

## Practical conclusion

REA supplied an additional structural inventory of the shipped artifact and a semantic graph. It did not replace source-level inspection of Cloudflare Worker request handling. The API map in `architecture.md` remains based on the actual recovered `index.ts` handler plus live read-only endpoint responses.

The full REA JSON report and a concise summary are available in the GitLab job artifacts for 30 days. The report is intentionally not committed as an 11 MB repository file.
