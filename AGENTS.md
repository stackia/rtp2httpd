# rtp2httpd

RTP/IPTV multicast-to-HTTP streaming daemon written in C, with a React/TypeScript web UI embedded into the binary.

## Architecture

- Pure C (C11) — do NOT introduce C++ code or features
- Multi-worker model via `fork()` — workers are independent, only sharing stats via shared memory
- Cross-platform: Linux, macOS, FreeBSD — use `#ifdef` for platform-specific APIs
- Web UI (React/Vite) is compiled and embedded as `src/embedded_web_data.h` — never edit this file directly
- If `src/embedded_web_data.h` changes from a Web UI rebuild, do not commit it unless explicitly requested.
- Config file format is INI (`rtp2httpd.conf`), not YAML/JSON

## Code Style — C

- Indentation: 2 spaces, no tabs
- Structs: `_s` suffix for struct tag, `_t` for typedef (`struct connection_s` → `connection_t`)
- Header guards: `#ifndef __MODULE_H__` / `#define __MODULE_H__`
- Logging: always use `logger()` from `utils.h` — never `printf` / `fprintf`
- Strings: use `snprintf` / `strncpy` — never `sprintf` / `strcpy`

## Code Style — TypeScript / JavaScript

- Formatter/linter: Biome (`biome.json`), line width 120, indent with tabs
- Follow `.nvmrc` via `nvm` + Corepack (`pnpm`) for JS tooling when available; if `nvm` is unavailable, fall back to the system `node`.
- Prefer Tailwind CSS utilities for styling; add custom CSS classes only when Tailwind cannot express the behavior clearly.

## Code Style — Python

- Package manager: uv — do not use pip/pipenv/poetry
- Always run Python scripts via `uv run` — do not use `python` directly

## Documentation

- Chinese docs (`docs/`) are the **single source of truth**
- English docs (`docs/en/`) are translations — always use the `translate-docs-zh-en` skill, do not translate directly
- Built with VitePress: `pnpm run docs:build`

## Git

- Commit messages and PR titles use Conventional Commits: `type(scope): subject`

## Do NOT

- Use Linux-only APIs without `#ifdef` platform guards
- Use npm/yarn — this project uses pnpm
- Use autotools — this project uses CMake
- Add dependencies without discussing first

## Cursor Cloud specific instructions

Toolchain is pre-installed and refreshed by the startup update script (`pnpm install --frozen-lockfile`
then `uv sync --group dev`). Standard commands live in `package.json` scripts and the `build-run` /
`e2e` skills — use those rather than reinventing them.

Non-obvious notes:

- **Dev lab**: `tools/devlab/devlab.py` starts local mock upstreams for Web UI/player debugging,
  including live, catchup, RTP multicast, HLS, and RTSP scenarios. See `tools/devlab/README.md`.
