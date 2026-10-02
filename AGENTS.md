# rtp2httpd

RTP/IPTV multicast-to-HTTP daemon in C11, with an embedded React/TypeScript web UI.

## Project constraints

- Keep runtime code in C, with platform guards for Linux, macOS, and FreeBSD APIs.
- Workers use `fork()`: globals are worker-local; cross-worker state needs shared memory or IPC.
- Build with CMake. Configuration is INI (`rtp2httpd.conf`).
- Never hand-edit `src/embedded_web_data.h`. Commit it only for an authorized release or when explicitly asked to commit the generated header.
- Discuss new dependencies first; installing locked dependencies is routine setup.

## Conventions

- C: 2-space indentation, `_s` struct tags, `_t` typedefs, `__MODULE_H__` guards. Log with `logger()` from `utils.h`; use `snprintf`/`strncpy`, not `sprintf`/`strcpy`.
- TypeScript/JavaScript: follow `biome.json`; prefer Tailwind utilities when they express the styling clearly.
- Use Corepack/pnpm and `.nvmrc` through nvm when available, otherwise system Node. Use uv for Python dependencies and `uv run` for scripts.
- Chinese documentation in `docs/` is authoritative. Use the translation skill below when synchronizing `docs/en/`.
- Commit messages and PR titles use `type(scope): subject`. Do not add `Co-Authored-By` trailers.

## Task-specific guidance

Read only the relevant guide; current commands live in `package.json` and `pyproject.toml`.

- Local build/configuration: [build-run](.agents/skills/build-run/SKILL.md).
- E2E tests/harness: [e2e](.agents/skills/e2e/SKILL.md).
- Release notes/publication: [release](.agents/skills/release/SKILL.md).
- English docs/navigation: [translate-docs-zh-en](.agents/skills/translate-docs-zh-en/SKILL.md).
- Community FCC reports: [sync-fcc-ip-docs](.agents/skills/sync-fcc-ip-docs/SKILL.md).
- Player mock upstreams: [devlab](tools/devlab/README.md).

## Completion and boundaries

Complete the requested change and affected checks, fixing regressions it causes. Local E2E tests use mock upstreams and temporary files; builds and affected tests can run and retry without per-step approval. Docs/instruction edits do not require daemon builds or the full E2E suite.

Use unused local ports and clean up task-owned processes/artifacts. Deployments and release publication need authorization; an existing request suffices. Respect draft-, review-, or upload-only scope.

Report results, validation, and blockers. Keep conversation/audit history out of deliverables.
