# kutu-cli

Zero-dependency Node.js (`>=20`, pure ESM) CLI toolkit for **cryptographic backup verification**, **prompt-risk auditing**, **AI provider configuration health**, and **workspace drift detection**.

## Key Capabilities
- **SHA-256 Verified Snapshots (`yedekci.mjs`, `kutu.mjs`)**: Hardlink-deduplicated incremental snapshots with full SHA-256 manifests, symlink/junction preservation, and pre/post restore verification (source trees are strictly read-only).
- **Prompt Risk Auditing (`promptscope.mjs`)**: Deterministic static scanner detecting instruction hijacking, override framing, hidden zero-width characters, refusal suppression, and exfiltration patterns with 0–100 line-cited scoring.
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
