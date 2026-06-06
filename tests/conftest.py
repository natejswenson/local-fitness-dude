"""Shared test setup.

``scripts/`` is a folder of standalone scripts, not a package, so we put it on
``sys.path`` and import each script by its stem (e.g. ``import score_prompt``).
"""
from __future__ import annotations

import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
