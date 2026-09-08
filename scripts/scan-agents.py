#!/usr/bin/python3
"""Bounded, read-only, resumable Claude/Codex JSONL scanner.

Run /usr/bin/python3 -I -S scan-agents.py MODE HOME; send a single cursor JSON
line on stdin. See Cursor/limits below. Stdout is ONE bounded v2 JSON envelope.
Only complete/partial envelopes may be committed, together with their cursor.

The helper starts NO children, threads, shell, external parser or subprocess.
It becomes the sole member of a private session/process group before reading
input. TERM exits; SIGALRM bounds the entire invocation; Qt can SIGKILL and reap
this one PID on destruction without leaving descendants. Nothing is detached.
All source opens are relative to pinned directory descriptors, O_NOFOLLOW and
O_NONBLOCK; fstat validates the descriptor actually read. No source is written.
"""

import copy
import datetime
import errno
import hashlib
import io
import json
import os
import re
import resource
import signal
import stat
import sys

MAX_SAFE = 9007199254740991
MAX_DATE = 8640000000000000
MAX_TOKEN = 10000000
MAX_CURSOR_BYTES = 2 * 1024 * 1024
MAX_OUTPUT_BYTES = 4 * 1024 * 1024
MAX_LINE_BYTES = 256 * 1024
MAX_FILE_BYTES = 16 * 1024 * 1024  # per pass, not maximum source file size
MAX_TOTAL_BYTES = 128 * 1024 * 1024
MAX_FILE_LINES = 50000
MAX_TOTAL_LINES = 500000
MAX_ENTRIES = 4096
MAX_FILES = 400
MAX_DEPTH = 16
MAX_ROWS = 2000
MAX_SEEN = 16384
DEADLINE_SECONDS = 8
MAX_MEMORY_BYTES = 256 * 1024 * 1024
READ_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
DIR_FLAGS = READ_FLAGS | os.O_DIRECTORY
MODEL = re.compile(r"[A-Za-z0-9._-]{1,40}\Z")
HEX = re.compile(r"[0-9a-f]{64}\Z")
UUID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\Z")
DECIMAL = re.compile(r"[0-9]{1,32}\Z")
CURSOR_KEYS = {"version", "revision", "files", "seen", "skipped"}
FILE_KEYS = {"path", "device", "inode", "offset", "anchor", "model", "totals",
             "discarding", "sessionId", "title", "cwd", "output", "updated"}


class ScanError(Exception):
    pass


def bounded_int(value, ceiling=MAX_SAFE):
    return type(value) is int and 0 <= value <= ceiling


def encode(value):
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"))


def empty_cursor():
    return {"version": 1, "revision": 0, "files": [], "seen": [], "skipped": 0}


def clean(value, limit):
    if not isinstance(value, str):
        return ""
    text = "".join(" " if ord(c) < 32 or 127 <= ord(c) <= 159 or 0xD800 <= ord(c) <= 0xDFFF or c == "|" else c
                   for c in value[:limit])
    # QML/JavaScript limits count UTF-16 code units, including emoji pairs.
    return text.encode("utf-16-le")[:limit * 2].decode("utf-16-le", errors="ignore")


def valid_text(value, limit):
    return isinstance(value, str) and len(value) <= limit and clean(value, limit) == value


def valid_model(value):
    return isinstance(value, str) and MODEL.fullmatch(value) is not None and value not in {
        "__proto__", "constructor", "prototype", "__defineGetter__", "__defineSetter__",
        "hasOwnProperty", "__lookupGetter__", "__lookupSetter__", "isPrototypeOf",
        "propertyIsEnumerable", "toString", "valueOf", "toLocaleString"}


def model_name(value, fallback):
    return value if valid_model(value) else fallback


def validate_cursor(value):
    if not isinstance(value, dict) or set(value) != CURSOR_KEYS or value["version"] != 1:
        raise ScanError("invalid-cursor")
    if not bounded_int(value["revision"], MAX_SAFE - 1) or not bounded_int(value["skipped"]):
        raise ScanError("invalid-cursor")
    files, seen = value["files"], value["seen"]
    if not isinstance(files, list) or len(files) > MAX_FILES or not isinstance(seen, list) or len(seen) > MAX_SEEN:
        raise ScanError("invalid-cursor")
    if any(not isinstance(s, str) or not HEX.fullmatch(s) for s in seen) or len(set(seen)) != len(seen):
        raise ScanError("invalid-cursor")
    paths = set()
    for item in files:
        if not isinstance(item, dict) or set(item) != FILE_KEYS:
            raise ScanError("invalid-cursor")
        path = item["path"]
        if (not valid_text(path, 1024) or not path or path.startswith("/") or
                any(part in {"", ".", ".."} for part in path.split("/")) or path in paths):
            raise ScanError("invalid-cursor")
        paths.add(path)
        if any(not isinstance(item[k], str) or not DECIMAL.fullmatch(item[k]) for k in ("device", "inode")):
            raise ScanError("invalid-cursor")
        if any(not bounded_int(item[k]) for k in ("offset", "output", "updated")):
            raise ScanError("invalid-cursor")
        if item["updated"] > MAX_DATE:
            raise ScanError("invalid-cursor")
        if not isinstance(item["anchor"], str) or (item["anchor"] != "" and not HEX.fullmatch(item["anchor"])):
            raise ScanError("invalid-cursor")
        if bool(item["offset"]) != bool(item["anchor"]) or type(item["discarding"]) is not bool:
            raise ScanError("invalid-cursor")
        if not valid_model(item["model"]) or not valid_text(item["title"], 160) or not valid_text(item["cwd"], 240):
            raise ScanError("invalid-cursor")
        if not isinstance(item["sessionId"], str) or (item["sessionId"] != "" and not UUID.fullmatch(item["sessionId"])):
            raise ScanError("invalid-cursor")
        total = item["totals"]
        if total is not None and (not isinstance(total, list) or len(total) != 4 or any(not bounded_int(n) for n in total)):
            raise ScanError("invalid-cursor")
    if len(encode(value).encode("utf-8")) > MAX_CURSOR_BYTES:
        raise ScanError("invalid-cursor")
    return value


def timestamp(value):
    if not isinstance(value, str) or len(value) > 40:
        return None
    try:
        stamp = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if stamp.tzinfo is None:
            return None
        epoch = datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)
        delta = stamp.astimezone(datetime.timezone.utc) - epoch
        millis = delta.days * 86400000 + delta.seconds * 1000 + delta.microseconds // 1000
        return millis if 0 < millis <= MAX_DATE else None
    except (ValueError, OverflowError):
        return None


def reject_constant(_value):
    raise ValueError("nonfinite")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def anchor(fd, offset):
    return digest(os.pread(fd, min(offset, 256), max(0, offset - 256))) if offset else ""


def checked_dir(name, parent=None, owned=True):
    fd = os.open(name, DIR_FLAGS, dir_fd=parent)
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode) or (owned and info.st_uid != os.getuid()):
        os.close(fd)
        raise ScanError("unsafe-file")
    return fd


def open_home(home):
    if not isinstance(home, str) or not home.startswith("/") or len(home) > 4096:
        raise ScanError("invalid-arguments")
    parts = home.split("/")[1:]
    if not parts or len(parts) > 32 or any(p in {"", ".", ".."} for p in parts):
        raise ScanError("invalid-arguments")
    fd = checked_dir("/", owned=False)
    try:
        for index, part in enumerate(parts):
            next_fd = checked_dir(part, fd, owned=index == len(parts) - 1)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


class BoundedInput(io.RawIOBase):
    """Charge actual descriptor reads, including BufferedReader read-ahead."""
    def __init__(self, fd, remaining, scanner):
        super().__init__()
        self.fd = fd
        self.remaining = remaining
        self.scanner = scanner
        self.bytes = 0

    def readable(self):
        return True

    def readinto(self, target):
        amount = min(len(target), self.remaining, MAX_FILE_BYTES - self.bytes,
                     MAX_TOTAL_BYTES - self.scanner.bytes)
        if amount <= 0:
            return 0
        chunk = os.read(self.fd, amount)
        self.bytes += len(chunk)
        self.scanner.bytes += len(chunk)
        self.remaining -= len(chunk)
        target[:len(chunk)] = chunk
        return len(chunk)


class Scanner:
    def __init__(self, provider, cursor):
        self.provider = provider
        self.cursor = copy.deepcopy(validate_cursor(cursor))
        self.files = {f["path"]: f for f in self.cursor["files"]}
        self.identities = {(f["device"], f["inode"]): f["path"] for f in self.cursor["files"]}
        if len(self.identities) != len(self.files):
            raise ScanError("invalid-cursor")
        self.seen = set(self.cursor["seen"])
        self.rows = []
        self.bytes = self.lines = self.entries = 0
        self.reason = ""
        self.pending = False
        self.stop = False

    def pause(self, reason):
        self.reason = self.reason or reason
        self.stop = True

    def skip(self):
        if self.cursor["skipped"] == MAX_SAFE:
            raise ScanError("cursor-limit")
        self.cursor["skipped"] += 1

    def new_file(self, path, info):
        if len(self.files) >= MAX_FILES:
            self.pause("file-limit")
            return None
        identity = (str(info.st_dev), str(info.st_ino))
        if identity in self.identities:
            # A hard-linked/renamed alias must not import the same bytes under
            # a fresh cursor. No path-based pre-check is trusted for this.
            raise ScanError("file-changed")
        candidate = path.rsplit("/", 1)[-1][:-6]
        item = {"path": path, "device": str(info.st_dev), "inode": str(info.st_ino),
                "offset": 0, "anchor": "", "model": self.provider, "totals": None,
                "discarding": False, "sessionId": candidate if UUID.fullmatch(candidate) else "",
                "title": "", "cwd": "", "output": 0, "updated": 0}
        self.files[path] = item
        self.identities[identity] = path
        self.cursor["files"].append(item)
        return item

    def usage(self, item, event, line_start):
        payload = event.get("payload")
        payload = payload if isinstance(payload, dict) else {}
        if self.provider == "claude":
            if isinstance(event.get("cwd"), str):
                item["cwd"] = clean(event["cwd"], 240)
            message = event.get("message")
            message = message if isinstance(message, dict) else {}
            content = message.get("content")
            if (not item["title"] and event.get("type") == "user" and isinstance(content, str)
                    and content and not content.startswith(("<", "Caveat"))):
                item["title"] = clean(content, 160)
            if event.get("type") != "assistant" or not isinstance(message.get("usage"), dict):
                return
            usage = message["usage"]
            raw_id = message.get("id")
            if not isinstance(raw_id, str) or re.fullmatch(r"[A-Za-z0-9._:-]{1,160}", raw_id) is None:
                self.skip()
                return
            record_id = digest(raw_id.encode("utf-8"))
            if record_id in self.seen:
                return
            if len(self.seen) >= MAX_SEEN:
                raise ScanError("cursor-limit")
            values = [usage.get(k, 0) for k in ("input_tokens", "cache_read_input_tokens",
                       "cache_creation_input_tokens", "output_tokens")]
            model = model_name(message.get("model"), "claude")
            total = None
        else:
            kind = event.get("type")
            if kind == "session_meta":
                session_id = payload.get("id")
                if isinstance(session_id, str) and UUID.fullmatch(session_id):
                    item["sessionId"] = session_id
                if not item["cwd"] and isinstance(payload.get("cwd"), str):
                    item["cwd"] = clean(payload["cwd"], 240)
            elif kind == "turn_context":
                item["model"] = model_name(payload.get("model"), item["model"])
                if isinstance(payload.get("cwd"), str):
                    item["cwd"] = clean(payload["cwd"], 240)
            elif (kind == "response_item" and payload.get("type") == "message" and
                  payload.get("role") == "user" and not item["title"]):
                content = payload.get("content")
                if isinstance(content, list):
                    for block in content[:64]:
                        if isinstance(block, dict) and block.get("type") == "input_text":
                            text = block.get("text")
                            if isinstance(text, str) and text and not text.startswith("<"):
                                item["title"] = clean(text, 160)
                                break
            if kind != "event_msg" or payload.get("type") != "token_count":
                return
            info = payload.get("info")
            if info is None:  # rate-limit-only event; no usage was recorded
                return
            if not isinstance(info, dict) or not isinstance(info.get("last_token_usage"), dict):
                self.skip()
                return
            usage = info["last_token_usage"]
            cumulative = info.get("total_token_usage")
            total = ([cumulative.get(k, 0) for k in ("input_tokens", "cached_input_tokens",
                      "cache_write_input_tokens", "output_tokens")] if isinstance(cumulative, dict) else None)
            if total is None or any(not bounded_int(v) for v in total) or total[1] > total[0]:
                self.skip()
                return
            if item["totals"] == total:
                return  # repeated token_count telemetry, not another API reply
            values = [usage.get(k, 0) for k in ("input_tokens", "cached_input_tokens",
                       "cache_write_input_tokens", "output_tokens")]
            if all(bounded_int(v, MAX_TOKEN) for v in values) and values[1] <= values[0]:
                values[0] -= values[1]
            else:
                self.skip()
                return
            model = item["model"]
            record_id = digest((item["device"] + ":" + item["inode"] + ":" + str(line_start)).encode("ascii"))
        when = timestamp(event.get("timestamp"))
        if (when is None or any(not bounded_int(v, MAX_TOKEN) for v in values) or
                values[0] + values[2] > MAX_TOKEN or item["output"] + values[3] > MAX_SAFE):
            self.skip()
            return
        self.rows.append("|".join(str(v) for v in [when, record_id, model, *values]))
        item["output"] += values[3]
        item["model"] = model
        if self.provider == "claude":
            self.seen.add(record_id)
            self.cursor["seen"].append(record_id)
        else:
            item["totals"] = total

    def read_file(self, directory, name, path):
        fd = os.open(name, READ_FLAGS, dir_fd=directory)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid() or before.st_size > MAX_SAFE:
                raise ScanError("unsafe-file")
            item = self.files.get(path) or self.new_file(path, before)
            if item is None:
                return
            if (item["device"] != str(before.st_dev) or item["inode"] != str(before.st_ino) or
                    before.st_size < item["offset"] or anchor(fd, item["offset"]) != item["anchor"]):
                raise ScanError("file-changed")
            start_offset = item["offset"]
            file_lines = 0
            os.lseek(fd, item["offset"], os.SEEK_SET)
            raw_source = BoundedInput(fd, before.st_size - item["offset"], self)
            with io.BufferedReader(raw_source, buffer_size=65536) as source:
                while item["offset"] < before.st_size:
                    if len(self.rows) >= MAX_ROWS:
                        self.pause("row-limit")
                        break
                    if file_lines >= MAX_FILE_LINES or self.lines >= MAX_TOTAL_LINES:
                        self.reason = self.reason or "work-limit"
                        if self.bytes >= MAX_TOTAL_BYTES or self.lines >= MAX_TOTAL_LINES:
                            self.stop = True
                        break
                    # readline itself is capped. Oversized records are discarded in
                    # chunks and explicitly counted; even a multi-GB line cannot be
                    # materialised, and discard state continues in the next pass.
                    line_start = item["offset"]
                    chunk = source.readline(min(MAX_LINE_BYTES + 1, before.st_size - item["offset"]))
                    if not chunk:
                        if raw_source.bytes >= MAX_FILE_BYTES or self.bytes >= MAX_TOTAL_BYTES:
                            self.reason = self.reason or "work-limit"
                            self.stop = self.bytes >= MAX_TOTAL_BYTES
                            break
                        raise ScanError("file-changed")
                    newline = chunk.endswith(b"\n")
                    if item["discarding"]:
                        item["offset"] += len(chunk)
                        item["discarding"] = not newline
                    elif len(chunk) > MAX_LINE_BYTES:
                        self.skip()
                        item["offset"] += len(chunk)
                        item["discarding"] = not newline
                    elif not newline:
                        # A partial last write or batch boundary: leave its offset
                        # at the line start, so no fragments are mistaken for JSON.
                        self.pending = item["offset"] + len(chunk) == before.st_size
                        self.reason = self.reason or "work-limit"
                        break
                    else:
                        try:
                            event = json.loads(chunk, parse_constant=reject_constant)
                        except (ValueError, UnicodeDecodeError, RecursionError):
                            self.skip()
                        else:
                            if isinstance(event, dict):
                                self.usage(item, event, line_start)
                            else:
                                self.skip()
                        item["offset"] += len(chunk)
                    if newline:
                        file_lines += 1
                        self.lines += 1
            after = os.fstat(fd)
            # Appends are safe: only the snapshotted prefix was read. Truncation,
            # or an in-place change without growth during this pass, is rejected.
            if (after.st_size < before.st_size or (after.st_size == before.st_size and
                    (after.st_mtime_ns != before.st_mtime_ns or after.st_ctime_ns != before.st_ctime_ns))):
                raise ScanError("file-changed")
            if after.st_size > before.st_size:
                self.reason = self.reason or "work-limit"
            item["anchor"] = anchor(fd, item["offset"])
            item["updated"] = max(0, min(MAX_DATE, before.st_mtime_ns // 1000000))
            if item["offset"] < before.st_size and item["offset"] == start_offset:
                self.reason = self.reason or "work-limit"
        finally:
            os.close(fd)

    def walk(self, directory, prefix="", depth=0):
        # scandir streams entries. No listdir, find, global sort or file-list
        # materialisation occurs before the traversal budget is checked.
        with os.scandir(directory) as entries:
            for entry in entries:
                if self.stop:
                    break
                self.entries += 1
                if self.entries > MAX_ENTRIES:
                    self.pause("entry-limit")
                    break
                name = entry.name
                path = prefix + name
                if not valid_text(path, 1024):
                    raise ScanError("unsafe-file")
                try:
                    child = checked_dir(name, directory)
                except OSError as exc:
                    if exc.errno not in (errno.ENOTDIR, errno.ELOOP):
                        raise
                    if entry.is_symlink():
                        raise ScanError("unsafe-file")
                    matches = name.endswith(".jsonl") and (self.provider == "claude" or name.startswith("rollout-"))
                    if matches:
                        self.read_file(directory, name, path)
                else:
                    try:
                        if depth >= MAX_DEPTH:
                            self.pause("depth-limit")
                        else:
                            self.walk(child, path + "/", depth + 1)
                    finally:
                        os.close(child)

    def scan(self, home):
        home_fd = open_home(home)
        directory = None
        try:
            try:
                provider_fd = checked_dir(".claude" if self.provider == "claude" else ".codex", home_fd)
                try:
                    directory = checked_dir("projects" if self.provider == "claude" else "sessions", provider_fd)
                finally:
                    os.close(provider_fd)
            except FileNotFoundError:
                if self.files:
                    raise ScanError("source-missing")
            if directory is not None:
                self.walk(directory)
        finally:
            if directory is not None:
                os.close(directory)
            os.close(home_fd)
        self.cursor["revision"] += 1
        if len(encode(self.cursor).encode("utf-8")) > MAX_CURSOR_BYTES:
            raise ScanError("cursor-limit")
        reason = "skipped-records" if self.cursor["skipped"] else "pending-record" if self.pending else self.reason
        return {"version": 2, "status": "partial" if reason else "complete", "reason": reason,
                "rows": "\n".join(self.rows), "cursor": self.cursor}


def session_result(cursor):
    rows = []
    for item in sorted(cursor["files"], key=lambda item: item["updated"], reverse=True):
        if item["sessionId"] and item["output"]:
            rows.append("|".join(str(v) for v in [item["sessionId"], item["title"], item["output"],
                         item["model"], item["cwd"], item["updated"]]))
            if len(rows) == 100:
                break
    reason = "skipped-records" if cursor["skipped"] else ""
    return {"version": 2, "status": "partial" if reason else "complete", "reason": reason,
            "rows": "\n".join(rows), "cursor": cursor}


def on_signal(number, _frame):
    if number == signal.SIGALRM:
        # A deadline also bounds a blocked stdout pipe. Raising and attempting
        # to print an error after consuming the only alarm could block forever.
        os._exit(3)
    raise ScanError("cancelled")


def harden():
    # Fail closed if private-group creation fails. This PID is the group's only
    # member throughout its lifetime: this module never forks or starts tools.
    os.setsid()
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGALRM, on_signal)
    signal.setitimer(signal.ITIMER_REAL, DEADLINE_SECONDS)
    resource.setrlimit(resource.RLIMIT_AS, (MAX_MEMORY_BYTES, MAX_MEMORY_BYTES))
    resource.setrlimit(resource.RLIMIT_CPU, (DEADLINE_SECONDS, DEADLINE_SECONDS + 1))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def main():
    cursor = empty_cursor()
    result = None
    code = 0
    try:
        harden()
        if len(sys.argv) != 3 or sys.argv[1] not in {
                "claude-usage", "codex-usage", "claude-sessions", "codex-sessions"}:
            raise ScanError("invalid-arguments")
        raw = sys.stdin.buffer.readline(MAX_CURSOR_BYTES + 2)
        if len(raw) > MAX_CURSOR_BYTES + 1 or not raw.endswith(b"\n"):
            raise ScanError("invalid-cursor")
        try:
            cursor = validate_cursor(json.loads(raw, parse_constant=reject_constant))
        except (ValueError, UnicodeDecodeError, RecursionError):
            raise ScanError("invalid-cursor") from None
        provider, mode = sys.argv[1].split("-")
        result = Scanner(provider, cursor).scan(sys.argv[2]) if mode == "usage" else session_result(cursor)
    except ScanError as exc:
        result = {"version": 2, "status": "error", "reason": str(exc), "rows": "", "cursor": cursor}
        code = 3
    except OSError as exc:
        reason = "unsafe-file" if exc.errno in (errno.ELOOP, errno.ENOTDIR, errno.EACCES, errno.EPERM) else "read-error"
        result = {"version": 2, "status": "error", "reason": reason, "rows": "", "cursor": cursor}
        code = 3
    except MemoryError:
        result = {"version": 2, "status": "error", "reason": "memory-limit", "rows": "", "cursor": empty_cursor()}
        code = 3
    except Exception:
        # Never include filenames, transcript text, environment or tracebacks.
        result = {"version": 2, "status": "error", "reason": "internal-error", "rows": "", "cursor": empty_cursor()}
        code = 3
    try:
        output = encode(result).encode("utf-8") + b"\n"
        if len(output) > MAX_OUTPUT_BYTES:
            output = (encode({"version": 2, "status": "error", "reason": "cursor-limit",
                              "rows": "", "cursor": empty_cursor()}) + "\n").encode("ascii")
            code = 3
        sys.stdout.buffer.write(output)
        sys.stdout.buffer.flush()
    except (BrokenPipeError, ScanError):
        code = 3
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
    return code


if __name__ == "__main__":
    sys.exit(main())
