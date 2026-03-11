"""Shared constants for rtp2httpd E2E tests."""

from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
BINARY_PATH = PROJECT_ROOT / "build" / "rtp2httpd"
FIXTURES_DIR = PROJECT_ROOT / "tools" / "fixtures"

LOOPBACK_IF = "lo0" if sys.platform == "darwin" else "lo"
MCAST_ADDR = "239.255.0.1"
