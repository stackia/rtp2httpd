# rtp2httpd

RTP/IPTV multicast-to-HTTP streaming daemon written in C, with a React/TypeScript web UI embedded into the binary.

## Architecture

- Pure C (C11) — do NOT introduce C++ code or features
- Multi-worker model via `fork()` — workers are independent, only sharing stats via shared memory
- Cross-platform: Linux, macOS, FreeBSD — use `#ifdef` for platform-specific APIs
- Web UI (React/Vite) is compiled and embedded as `src/embedded_web_data.h` — never edit this file directly
- Config file format is INI (`rtp2httpd.conf`), not YAML/JSON

## Code Style — C

- Indentation: 2 spaces, no tabs
- Structs: `_s` suffix for struct tag, `_t` for typedef (`struct connection_s` → `connection_t`)
- Header guards: `#ifndef __MODULE_H__` / `#define __MODULE_H__`
- Logging: always use `logger()` from `utils.h` — never `printf` / `fprintf`
- Strings: use `snprintf` / `strncpy` — never `sprintf` / `strcpy`

## Code Style — TypeScript / JavaScript

- Formatter/linter: Biome (`biome.json`), line width 120, indent with tabs

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
