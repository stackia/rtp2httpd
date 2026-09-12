---
name: build-run
description: Build, configure, and run rtp2httpd locally, including embedded Web UI builds and build/runtime troubleshooting. Excludes cross-compilation and deployment.
---

# Local Build and Run

Run commands from the repository root. Use the toolchain conventions in [AGENTS.md](../../../AGENTS.md).

Cursor Cloud's startup setup installs locked pnpm dependencies and runs `uv sync --group dev`. Reuse that environment; repeat setup only when dependencies are missing or changed.

## Build the needed components

For embedded UI changes, rebuild the frontend before the C binary. C-only changes can use the committed header without Node.js. Follow `package.json` for build scripts and `CMakeLists.txt` for current options.

```bash
# When Web UI sources or build inputs changed:
pnpm run web-ui:build

cmake -B build -DCMAKE_BUILD_TYPE=Release -DENABLE_AGGRESSIVE_OPT=ON
cmake --build build -j$(getconf _NPROCESSORS_ONLN)
```

Release is the default for normal builds. Use Debug/RelWithDebInfo or `pnpm run web-ui:build:debug` when diagnosis needs symbols or source maps. `ENABLE_AGGRESSIVE_OPT` enables LTO and fast-math and defaults to OFF in CMake; disable it when investigating optimization-sensitive behavior.

The binary is `build/rtp2httpd`. The generated header follows the commit boundary in AGENTS.md.

## Run and configure

Use an unused port, bind a local preview to loopback, and avoid loading a deployed configuration accidentally:

```bash
./build/rtp2httpd -C -v -v -v -v -l 127.0.0.1:8080
```

`-C` skips the default config; `-c <file>` selects a config; `-l [addr:]port` sets the listener. For a config-based reproduction, inspect that file's listeners and upstreams first. Use `./build/rtp2httpd --help` for current flags.

- For INI settings and `[global]`, `[bind]`, `[services]` examples, read [rtp2httpd.conf](../../../rtp2httpd.conf) and the relevant section of [Configuration Reference](../../../docs/reference/configuration.md). CLI settings take precedence.
- For stream paths and query parameters, read [URL Formats](../../../docs/guide/url-formats.md). The `/rtp/`, `/rtsp/`, and `/http/` prefixes choose different protocol handlers.
- For player scenarios using mock upstreams, use [devlab](../../../tools/devlab/README.md).
- For automated daemon behavior checks, use [e2e](../e2e/SKILL.md).

## Verify the requested behavior

`curl --fail http://127.0.0.1:8080/status` checks basic readiness. Playback, seek, or rendering work also needs the affected stream/player scenario; a status response alone does not verify it. Reuse the chosen listener port in checks, and stop the task's daemon when finished. If a port is occupied, choose another port rather than terminating an unrelated process.
