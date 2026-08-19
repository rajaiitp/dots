#!/usr/bin/env python3
"""One-time migration from Fish's YAML history to Zsh extended history."""

from __future__ import annotations

import argparse
import re
from pathlib import Path

ENTRY = re.compile(r"^- cmd: (.*)$")
WHEN = re.compile(r"^  when: (\d+)$")


def entries(history: Path):
    command: str | None = None
    timestamp = "0"
    for line in history.read_text(encoding="utf-8", errors="replace").splitlines():
        match = ENTRY.match(line)
        if match:
            if command is not None:
                yield timestamp, command
            command = match.group(1)
            timestamp = "0"
            continue
        match = WHEN.match(line)
        if command is not None and match:
            timestamp = match.group(1)
    if command is not None:
        yield timestamp, command


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        default=Path.home() / ".local/share/fish/fish_history",
        help="Fish history file (default: %(default)s)",
    )
    parser.add_argument(
        "--destination",
        type=Path,
        default=Path.home() / ".zsh_history",
        help="Zsh history file (default: %(default)s)",
    )
    args = parser.parse_args()

    if not args.source.is_file():
        print(f"Fish history not found: {args.source}")
        return 0

    records = list(entries(args.source))
    if not records:
        print(f"No commands found in {args.source}")
        return 0

    args.destination.parent.mkdir(parents=True, exist_ok=True)
    with args.destination.open("a", encoding="utf-8") as target:
        for timestamp, command in records:
            # Zsh's extended-history format uses a newline to delimit entries.
            # Fish multiline commands are preserved as one executable command.
            command = command.replace("\n", " ")
            target.write(f": {timestamp}:0;{command}\n")

    print(f"Imported {len(records)} Fish history entries into {args.destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
