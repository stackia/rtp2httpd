---
name: build-run
description: >
  Build, run, and configure rtp2httpd locally. Use this skill whenever the user wants to compile
  the project, start the daemon, pass command-line arguments, edit configuration, or troubleshoot
  build/runtime issues. Also activate when the user mentions cmake, build directory, rtp2httpd.conf,
  or asks how to test the service locally.
---

# Building and Running rtp2httpd

rtp2httpd is a C daemon (CMake build system) that converts RTP multicast / RTSP / HTTP streams
to HTTP unicast. This skill covers local development builds — not OpenWrt cross-compilation.

## Build

```bash
# Configure (Debug for development, Release for performance)
cmake -B build -DCMAKE_BUILD_TYPE=Debug

# Compile
cmake --build build -j$(nproc)
```

The binary lands at `build/rtp2httpd`.

### Build options

| CMake option              | Default | Purpose                              |
|---------------------------|---------|--------------------------------------|
| `CMAKE_BUILD_TYPE`        | Release | Debug / Release / RelWithDebInfo     |
| `ENABLE_AGGRESSIVE_OPT`   | OFF     | LTO, fast-math, loop unrolling       |

## Run

```bash
# Minimal: no config file, verbose, listen on port 8080
./build/rtp2httpd -C -v -v -v -v -l 8080

# With a config file
./build/rtp2httpd -c rtp2httpd.conf

# Override specific settings via CLI
./build/rtp2httpd -c rtp2httpd.conf -l 5140 -m 20 -v -v
```

### Commonly used CLI flags

| Flag               | Short | Purpose                                    |
|--------------------|-------|--------------------------------------------|
| `--noconfig`       | `-C`  | Skip default config file                   |
| `--config <file>`  | `-c`  | Use specific config file                   |
| `--listen [addr:]port` | `-l` | Bind address/port (default ANY:5140)   |
| `--verbose`        | `-v`  | Increase verbosity (stack up to 4 times)   |
| `--maxclients <n>` | `-m`  | Max simultaneous clients (default 5)       |
| `--help`           | `-h`  | Show all available options                 |

Run `./build/rtp2httpd --help` for the complete flag list.

## Configuration

The config file is INI-style with three sections: `[global]`, `[bind]`, `[services]`.

- **Reference config**: `rtp2httpd.conf` in the project root — all options are documented with comments
- **Full docs**: `docs/.vitepress/dist/reference/configuration.md`

When both CLI flags and config file settings are present, CLI flags take precedence.

### Quick config example

```ini
[global]
verbosity = 3

[bind]
* 5140

[services]
#EXTM3U
#EXTINF:-1,Channel One
rtp://239.253.64.120:5140
#EXTINF:-1,RTSP Channel
rtsp://10.0.0.50:554/live
#EXTINF:-1,HTTP Channel
http://upstream.example.com/stream
```

## Verify it works

```bash
# Status page
curl http://127.0.0.1:5140/status

# M3U playlist (if services configured)
curl http://127.0.0.1:5140/playlist.m3u

# Stream a channel (replace with actual multicast addr)
curl http://127.0.0.1:5140/rtp/239.253.64.120:5140 --max-time 3 -o /dev/null -w "%{http_code}"
```

## Troubleshooting

- **Port in use**: change `-l` port or kill the old process
