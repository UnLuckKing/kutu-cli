# kutu-cli

[![CI](https://github.com/UnLuckKing/kutu-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/UnLuckKing/kutu-cli/actions/workflows/ci.yml)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)
![Zero Dependencies](https://img.shields.io/badge/dependencies-0-success.svg)

Zero-dependency Node.js (`>=20`, pure ESM) CLI toolkit for **cryptographic backup verification**, **prompt-risk auditing**, **AI provider configuration health**, and **workspace drift detection**.

## Key Capabilities
- **SHA-256 Verified Snapshots (`yedekci.mjs`, `kutu.mjs`)**: Hardlink-deduplicated incremental snapshots with full SHA-256 manifests, symlink/junction preservation, and pre/post restore verification (source trees are strictly read-only).
- **Prompt Risk & AgentDojo Indirect-Injection Auditing (`promptscope.mjs` v1.1)**: Deterministic static scanner detecting instruction hijacking, override framing, refusal suppression, HTML comment directives (`<!-- ... -->`), Markdown image URL exfiltration, fake chat/tool boundary spoofing (`<|im_start|>`, `<tool_response>`), indirect tool hijacking (EN + TR), BiDi overrides, and invisible Unicode Tag smuggling (`U+E0000–U+E007F`) with 0–100 line-cited scoring.
- **AI Config & Secret Hygiene Doctor (`aidoctor.mjs`)**: Audits multi-provider AI configurations for unresolved env variables, inline key leaks (never prints secret values), duplicate bindings, and local endpoint health.
- **Archive & Drift Diagnostics (`arsivci.mjs`, `arsiv-rapor.mjs`, `karsilastir.mjs`, `senkron.mjs`, `dogrula.mjs`)**: Integrity audits, HTML reporting, baseline diffing, and skill-directory synchronization checks.

## Quick Start

```bash
# Run the full test suite (zero external dependencies)
node --test *.test.mjs

# Show CLI help
node kutu.mjs --help

# Scan a prompt/instruction file for risk patterns
node kutu.mjs prompt --file ./instructions.md

# Take a SHA-256 verified snapshot
node kutu.mjs yedekle --src ./my-project --dest ./backups
```

## Design Invariants
- **Zero third-party runtime dependencies** (`node:*` built-ins only).
- **Read-only by default** on source directories; restores always target a new directory.
- **Secret redaction** enforced across JSON and text reports.
