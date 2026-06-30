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

Non-obvious gotchas discovered during setup:

- **Node version**: the project pins Node `lts/krypton` (v24) via `.nvmrc`; nvm's default alias is set
  to it, so a login shell resolves Node 24, the corepack `pnpm@11.9.0`, and `uv`. A bare non-login
  shell may instead pick up the system `/exec-daemon/node` (v22) that shadows nvm — run inside a login
  shell (or `nvm use`) when the exact version matters.
- **`-v` takes a numeric argument**: in this build `-v` is `--verbose <level>` (e.g. `-v 4`), NOT a
  stackable flag. `./build/rtp2httpd ... -v -v -v` fails with "option requires an argument". Set
  `verbosity` in the config file or pass `-v <0-4>`.
- **Loopback multicast**: to stream/receive RTP multicast on this VM (manual testing or multicast e2e
  tests), start the daemon with `-r lo` so it joins the group on the loopback interface; senders must
  set `IP_MULTICAST_IF` to `127.0.0.1`. The e2e multicast fixtures already pass `-r lo`.
