#!/usr/bin/env python3
"""Run Tuxedo in a Herdr popup; Ctrl-N closes the popup."""

from __future__ import annotations

import errno
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import tty
from pathlib import Path

CLOSE_KEY = b"\x0e"  # Ctrl-N
PR_SET_PDEATHSIG = 1


def set_parent_death_signal() -> None:
    """Ensure Tuxedo cannot outlive the popup wrapper."""
    import ctypes

    ctypes.CDLL(None).prctl(PR_SET_PDEATHSIG, signal.SIGTERM, 0, 0, 0)


def copy_window_size(source: int, target: int) -> None:
    try:
        size = fcntl.ioctl(source, termios.TIOCGWINSZ, b"\0" * 8)
        fcntl.ioctl(target, termios.TIOCSWINSZ, size)
    except OSError:
        pass


def main() -> int:
    notes_dir = Path(os.environ.get("TODO_DIR", "~/notes")).expanduser()
    env = os.environ.copy()
    env["TODO_DIR"] = str(notes_dir)
    env.setdefault("TODO_FILE", str(notes_dir / "todo.txt"))

    master, slave = pty.openpty()
    copy_window_size(sys.stdin.fileno(), slave)
    child = subprocess.Popen(
        ["tuxedo"],
        cwd=notes_dir,
        env=env,
        stdin=slave,
        stdout=slave,
        stderr=slave,
        start_new_session=True,
        preexec_fn=set_parent_death_signal,
    )
    os.close(slave)

    old_terminal = termios.tcgetattr(sys.stdin.fileno())
    closed_by_key = False
    stop_requested = False

    def handle_signal(_signum: int, _frame: object) -> None:
        nonlocal stop_requested
        stop_requested = True
        if child.poll() is None:
            child.terminate()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGHUP, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    def resize(_signum: int, _frame: object) -> None:
        copy_window_size(sys.stdin.fileno(), master)

    signal.signal(signal.SIGWINCH, resize)
    try:
        tty.setraw(sys.stdin.fileno())
        while True:
            if child.poll() is not None:
                break
            readable, _, _ = select.select([sys.stdin.fileno(), master], [], [], 0.1)
            for descriptor in readable:
                try:
                    data = os.read(descriptor, 65536)
                except OSError as error:
                    if error.errno == errno.EIO:
                        data = b""
                    else:
                        raise
                if not data:
                    stop_requested = True
                    if child.poll() is None:
                        child.terminate()
                    break
                if descriptor == sys.stdin.fileno():
                    if CLOSE_KEY in data:
                        closed_by_key = True
                        child.terminate()
                        break
                    os.write(master, data)
                else:
                    os.write(sys.stdout.fileno(), data)
            if closed_by_key or stop_requested:
                break
    finally:
        termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, old_terminal)
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=1)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        os.close(master)

    return 0 if closed_by_key else (child.returncode or 0)


if __name__ == "__main__":
    raise SystemExit(main())
