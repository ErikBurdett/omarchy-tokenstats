#!/usr/bin/python3
"""Read one bounded, owned JSON config without following pathname symlinks.

Invoked as /usr/bin/python3 -I -S read-config.py /absolute/config/path with a
cleared environment. All checks and reads use the same pinned descriptors;
this helper starts no children and writes no files. stdout is at most 256 KiB.
"""

import json
import math
import os
import signal
import stat
import sys

MAX_BYTES = 256 * 1024
MAX_PATH = 4096
MAX_COMPONENTS = 256
MAX_JSON_DEPTH = 64
MAX_JSON_VALUES = 16384
DEADLINE_SECONDS = 3
OPEN_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC


class RejectedConfig(Exception):
    pass


def reject_constant(_value):
    raise RejectedConfig()


def read_config(path):
    """Return validated JSON bytes, or reject before emitting any output."""
    if not isinstance(path, str) or not path.startswith("/") or len(path) > MAX_PATH:
        raise RejectedConfig()
    parts = [part for part in path.split("/") if part]
    if not parts or len(parts) > MAX_COMPONENTS or any(part in (".", "..") for part in parts):
        raise RejectedConfig()

    directory = os.open("/", OPEN_FLAGS | os.O_DIRECTORY)
    try:
        # Opening each directory relative to its predecessor also refuses
        # symlinks in parents, including an XDG directory redirected by a link.
        # A caller can instead configure XDG_CONFIG_HOME to the real directory.
        for part in parts[:-1]:
            child = os.open(part, OPEN_FLAGS | os.O_DIRECTORY, dir_fd=directory)
            os.close(directory)
            directory = child
        file_fd = os.open(parts[-1], OPEN_FLAGS, dir_fd=directory)
        try:
            info = os.fstat(file_fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                raise RejectedConfig()
            if info.st_size <= 0 or info.st_size > MAX_BYTES:
                raise RejectedConfig()
            # Read one extra byte: a file may grow after fstat. Neither a size
            # check alone nor an unrestricted read() would cap that case.
            chunks = []
            remaining = MAX_BYTES + 1
            while remaining:
                chunk = os.read(file_fd, min(65536, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            payload = b"".join(chunks)
        finally:
            os.close(file_fd)
    finally:
        os.close(directory)

    if not payload or len(payload) > MAX_BYTES:
        raise RejectedConfig()
    try:
        doc = json.loads(payload.decode("utf-8"), parse_constant=reject_constant)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise RejectedConfig() from error
    if not isinstance(doc, dict):
        raise RejectedConfig()
    # A small but deeply nested JSON document can still exhaust the QML
    # parser's stack. Bound structure too, using iterators rather than another
    # materialized list of every child.
    stack = [iter((doc,))]
    values = 0
    while stack:
        try:
            value = next(stack[-1])
        except StopIteration:
            stack.pop()
            continue
        values += 1
        if values > MAX_JSON_VALUES:
            raise RejectedConfig()
        if isinstance(value, (dict, list)):
            if len(stack) >= MAX_JSON_DEPTH:
                raise RejectedConfig()
            stack.append(iter(value.values() if isinstance(value, dict) else value))
        elif isinstance(value, float) and not math.isfinite(value):
            raise RejectedConfig()
    return payload


def deadline(_signum, _frame):
    # No descendants or pending writes to reap. A nonzero exit tells the
    # caller to discard stdout even if the output pipe itself was blocked.
    os._exit(124)


def main():
    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(DEADLINE_SECONDS)
    try:
        if len(sys.argv) != 2:
            raise RejectedConfig()
        payload = read_config(sys.argv[1])
        sys.stdout.buffer.write(payload)
        sys.stdout.buffer.flush()
        return 0
    except (RejectedConfig, OSError, ValueError):
        # Never disclose config content, paths, or exception text in shell logs.
        sys.stderr.write("Token Stats: configuration unavailable or rejected.\n")
        return 1
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    sys.exit(main())
