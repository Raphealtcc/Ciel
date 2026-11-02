# REA — Reverse Engineer Anything workflow

## Skill identified

- Repository: [morluto/rea](https://github.com/morluto/rea)
- Skill: [reverse-engineer-anything](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/SKILL.md)
- The skill routes JavaScript/Electron trees and ASARs to `analyze_javascript_application`.
- It distinguishes observed artifact evidence from inference and explicit unknowns.
- Installing the skill alone does not install or register the REA MCP server  .

## How it is being used here

The REA MCP server is not connected to the current ChatGPT session. The skill's documented CLI fallback is therefore invoked in GitLab CI:

```bash
npx -y rea-agents@latest analyze-javascript-application ciel/reconstructed --json
```

The CI image is Alpine Linux, whose BusyBox `ps` does not support the process-ownership query required by REA. The pipeline installs the `procps` package before running REA. This is a narrowly scoped prerequisite for that provider, not a source-code dependency of CIEL.

The complete JSON report and stderr log are stored as GitLab job artifacts for 30 days. The CI trace prints only a small summary to avoid dumping a potentially large report into logs.

## Scope and limits

- Target is the reconstructed deployed JavaScript Worker bundle, not a mobile app, native binary or Electron application.
- REA can inventory and analyze the recovered JavaScript artifacts. It cannot recover the original GitHub history, erased TypeScript types, missing source map, tests, or secrets.
- A successful static analysis is not runtime proof. Feed startup, Telegram delivery, button callbacks, D1 write behavior and staging deployment still require separate tests.
- Do not use the tool's inferred call graph or names as proof of external API semantics without matching code and runtime evidence.
