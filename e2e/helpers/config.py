"""Config builders for E2E tests."""

from __future__ import annotations

import os
import tempfile


def build_config(
    port: int,
    global_lines: list[str] | None = None,
    services_content: str | None = None,
) -> str:
    """Build a minimal rtp2httpd INI config."""
    lines = ["[global]", "verbosity = 4"]
    if global_lines:
        lines.extend(global_lines)
    lines.extend(["", "[bind]", f"* {port}"])

    if services_content:
        lines.extend(["", "[services]"])
        lines.extend(services_content.strip().splitlines())

    return "\n".join(lines) + "\n"


def build_single_service_config(
    port: int,
    service_name: str,
    service_url: str,
    global_lines: list[str] | None = None,
    extinf_attrs: str | None = None,
) -> str:
    """Build a config with one M3U service."""
    attrs = f" {extinf_attrs.strip()}" if extinf_attrs else ""
    services = "\n".join(
        [
            "#EXTM3U",
            f"#EXTINF:-1{attrs},{service_name}",
            service_url,
        ]
    )
    return build_config(port, global_lines=global_lines, services_content=services)


def write_temp_file(data: bytes, suffix: str = "", prefix: str = "r2h_test_") -> str:
    """Write bytes to a temporary file and return its path."""
    fd, path = tempfile.mkstemp(suffix=suffix, prefix=prefix)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return path
