#!/usr/bin/python3
"""Synthetic fixtures only: never reads the user's agent transcripts."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "scan-agents.py"
spec = importlib.util.spec_from_file_location("scan_agents", SCRIPT)
S = importlib.util.module_from_spec(spec)
spec.loader.exec_module(S)
SESSION = "11111111-2222-3333-4444-555555555555"


def claude(index=1, output=9, stamp="2026-09-08T12:00:00.123Z"):
    return {"type": "assistant", "timestamp": stamp,
            "message": {"id": "msg_" + str(index), "model": "claude-test",
                        "usage": {"input_tokens": 2, "cache_read_input_tokens": 30,
                                  "cache_creation_input_tokens": 4, "output_tokens": output}}}


def codex(total=9, output=9, stamp="2026-09-08T12:00:00.456Z"):
    return {"type": "event_msg", "timestamp": stamp, "payload": {"type": "token_count", "info": {
        "last_token_usage": {"input_tokens": 20, "cached_input_tokens": 15, "output_tokens": output},
        "total_token_usage": {"input_tokens": total * 20, "cached_input_tokens": total * 15,
                              "output_tokens": total}}}}


def encoded(event):
    return (json.dumps(event) + "\n").encode()


class Fixtures(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tokenstats-test-")
        self.home = Path(self.temp.name)
        self.claude_dir = self.home / ".claude" / "projects"
        self.codex_dir = self.home / ".codex" / "sessions"
        self.claude_dir.mkdir(parents=True)
        self.codex_dir.mkdir(parents=True)

    def tearDown(self):
        self.temp.cleanup()

    def fixture(self, provider, events):
        name = SESSION + ".jsonl" if provider == "claude" else "rollout-test.jsonl"
        path = (self.claude_dir if provider == "claude" else self.codex_dir) / name
        path.write_bytes(b"".join(encoded(event) for event in events))
        return path

    def scan(self, provider="claude", cursor=None):
        return S.Scanner(provider, cursor or S.empty_cursor()).scan(str(self.home))

    def process(self, mode="claude-usage", cursor=None, timeout=12):
        result = subprocess.run(["/usr/bin/python3", "-I", "-S", str(SCRIPT), mode, str(self.home)],
                                input=(S.encode(cursor or S.empty_cursor()) + "\n").encode(),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout,
                                env={})
        self.assertEqual(result.stderr, b"")
        self.assertLessEqual(len(result.stdout), S.MAX_OUTPUT_BYTES)
        return result, json.loads(result.stdout)

    def test_exact_claude_fractional_timestamp_and_dedup_across_batches(self):
        self.fixture("claude", [claude(), claude(), claude(2)])
        with patch.object(S, "MAX_ROWS", 1):
            first = self.scan()
            self.assertEqual(first["status"], "partial")
            self.assertEqual(first["reason"], "row-limit")
            second = self.scan(cursor=first["cursor"])
        rows = (first["rows"] + "\n" + second["rows"]).splitlines()
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0].split("|")[0], "1788868800123")
        self.assertEqual(rows[0].split("|")[3:], ["2", "30", "4", "9"])
        third = self.scan(cursor=second["cursor"])
        self.assertEqual(third["rows"], "")
        self.assertEqual(third["status"], "complete")
        self.assertEqual(third["cursor"]["revision"], 3)

    def test_codex_duplicate_counters_model_and_reset(self):
        events = [{"type": "session_meta", "payload": {"id": SESSION, "cwd": "/synthetic"}},
                  {"type": "turn_context", "payload": {"model": "gpt-test"}},
                  codex(), codex(), codex(13, 4), codex(2, 2)]
        self.fixture("codex", events)
        with patch.object(S, "MAX_ROWS", 1):
            result = self.scan("codex")
            result2 = self.scan("codex", result["cursor"])
            result3 = self.scan("codex", result2["cursor"])
        rows = (result["rows"] + "\n" + result2["rows"] + "\n" + result3["rows"]).splitlines()
        self.assertEqual([int(row.split("|")[-1]) for row in rows], [9, 4, 2])
        self.assertTrue(all(row.split("|")[2] == "gpt-test" for row in rows))
        self.assertEqual(rows[0].split("|")[3:6], ["5", "15", "0"])
        self.assertEqual(result3["cursor"]["files"][0]["output"], 15)
        sessions = S.session_result(result3["cursor"])
        self.assertEqual(sessions["rows"].split("|")[2], "15")

    def test_late_and_same_millisecond_appends_are_imported(self):
        path = self.fixture("claude", [claude()])
        first = self.scan()
        with path.open("ab") as f:
            f.write(encoded(claude(2)))
            f.write(encoded(claude(3, stamp="2026-09-07T01:00:00.001Z")))
        second = self.scan(cursor=first["cursor"])
        self.assertEqual(len(second["rows"].splitlines()), 2)

    def test_sparse_three_gigabyte_file_makes_bounded_forward_progress(self):
        path = self.fixture("codex", [codex()])
        with path.open("r+b") as f:
            f.truncate(3 * 1024**3)
        started = time.monotonic()
        first = self.scan("codex")
        second = self.scan("codex", first["cursor"])
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual(len(first["rows"].splitlines()), 1)
        self.assertEqual(second["rows"], "")
        self.assertGreater(second["cursor"]["files"][0]["offset"], first["cursor"]["files"][0]["offset"])
        self.assertLessEqual(first["cursor"]["files"][0]["offset"], S.MAX_FILE_BYTES)
        self.assertEqual(second["cursor"]["skipped"], 1)
        self.assertEqual(second["reason"], "skipped-records")
        self.assertEqual(second["status"], "partial")

    def test_oversized_line_then_valid_record_across_batches(self):
        path = self.fixture("claude", [])
        path.write_bytes(b"x" * 2500 + b"\n" + encoded(claude()))
        with patch.object(S, "MAX_LINE_BYTES", 500), patch.object(S, "MAX_FILE_BYTES", 1100):
            cursor = S.empty_cursor()
            rows = []
            for _ in range(4):
                result = self.scan(cursor=cursor)
                cursor = result["cursor"]
                rows.extend(result["rows"].splitlines())
        self.assertEqual(len(rows), 1)
        self.assertEqual(cursor["skipped"], 1)
        self.assertFalse(cursor["files"][0]["discarding"])
        self.assertEqual(cursor["files"][0]["offset"], path.stat().st_size)

    def test_partial_last_record_retries_without_loss(self):
        record = encoded(claude())
        path = self.fixture("claude", [])
        path.write_bytes(record[:-5])
        first = self.scan()
        self.assertEqual(first["reason"], "pending-record")
        self.assertEqual(first["cursor"]["files"][0]["offset"], 0)
        with path.open("ab") as f:
            f.write(record[-5:])
        second = self.scan(cursor=first["cursor"])
        self.assertEqual(len(second["rows"].splitlines()), 1)
        self.assertEqual(second["status"], "complete")

    def test_invalid_json_values_and_huge_nested_records_are_reported(self):
        path = self.fixture("claude", [])
        path.write_bytes(b"not JSON\n[1,2]\n{\"value\":NaN}\n" + b"[" * 2000 + b"]" * 2000 + b"\n" + encoded(claude()))
        result = self.scan()
        self.assertEqual(result["cursor"]["skipped"], 4)
        self.assertEqual(len(result["rows"].splitlines()), 1)
        self.assertEqual(result["reason"], "skipped-records")

    def test_unreasonable_or_wrong_typed_tokens_are_not_clamped(self):
        bad = claude()
        bad["message"]["usage"]["output_tokens"] = S.MAX_TOKEN + 1
        bad2 = claude(2)
        bad2["message"]["usage"]["input_tokens"] = True
        self.fixture("claude", [bad, bad2, claude(3)])
        result = self.scan()
        self.assertEqual(result["cursor"]["skipped"], 2)
        self.assertEqual(len(result["rows"].splitlines()), 1)

    def test_file_growth_budget_and_aggregate_budget_resume(self):
        path = self.fixture("claude", [claude(i) for i in range(10)])
        with patch.object(S, "MAX_FILE_BYTES", 1024), patch.object(S, "MAX_TOTAL_BYTES", 1024):
            first = self.scan()
        self.assertEqual(first["status"], "partial")
        self.assertLess(first["cursor"]["files"][0]["offset"], path.stat().st_size)
        second = self.scan(cursor=first["cursor"])
        self.assertEqual(len(first["rows"].splitlines()) + len(second["rows"].splitlines()), 10)

    def test_descriptor_read_budget_includes_buffered_read_ahead(self):
        self.fixture("claude", [claude(i) for i in range(100)])
        requested = []
        original_read = os.read

        def measured_read(fd, count):
            requested.append(count)
            return original_read(fd, count)

        with patch.object(S, "MAX_TOTAL_BYTES", 1000), patch.object(S.os, "read", measured_read):
            scanner = S.Scanner("claude", S.empty_cursor())
            result = scanner.scan(str(self.home))
        self.assertEqual(sum(requested), 1000)
        self.assertEqual(scanner.bytes, 1000)
        self.assertEqual(result["status"], "partial")

    def test_entry_file_depth_line_and_dedup_limits(self):
        self.fixture("claude", [claude(1), claude(2)])
        with patch.object(S, "MAX_ENTRIES", 0):
            self.assertEqual(self.scan()["reason"], "entry-limit")
        with patch.object(S, "MAX_FILES", 0):
            self.assertEqual(self.scan()["reason"], "file-limit")
        with patch.object(S, "MAX_FILE_LINES", 1):
            self.assertEqual(len(self.scan()["rows"].splitlines()), 1)
        with patch.object(S, "MAX_SEEN", 1):
            with self.assertRaisesRegex(S.ScanError, "cursor-limit"):
                self.scan()
        (self.claude_dir / "nested").mkdir()
        with patch.object(S, "MAX_DEPTH", 0):
            self.assertEqual(self.scan()["reason"], "depth-limit")

    def test_special_files_symlinks_and_symlinked_parent_fail_closed(self):
        path = self.claude_dir / "special.jsonl"
        os.mkfifo(path)
        result, body = self.process()
        self.assertEqual(result.returncode, 3)
        self.assertEqual(body["rows"], "")
        self.assertEqual(body["reason"], "unsafe-file")
        path.unlink()
        path.symlink_to(self.home / "missing")
        self.assertEqual(self.process()[1]["reason"], "unsafe-file")
        path.unlink()
        self.claude_dir.rmdir()
        self.claude_dir.symlink_to(self.codex_dir, target_is_directory=True)
        self.assertEqual(self.process()[1]["reason"], "unsafe-file")

    def test_socket_file_does_not_block(self):
        sock = socket.socket(socket.AF_UNIX)
        try:
            sock.bind(str(self.claude_dir / "socket.jsonl"))
            result, body = self.process()
            self.assertEqual(result.returncode, 3)
            self.assertEqual(body["rows"], "")
        finally:
            sock.close()

    def test_replaced_truncated_and_modified_files_reject_batch(self):
        path = self.fixture("claude", [claude()])
        first = self.scan()
        old_cursor = copy.deepcopy(first["cursor"])
        path.write_bytes(encoded(claude(9)))
        with self.assertRaisesRegex(S.ScanError, "file-changed"):
            self.scan(cursor=old_cursor)

        self.assertEqual(first["cursor"], old_cursor)
        path.write_bytes(b"")
        with self.assertRaisesRegex(S.ScanError, "file-changed"):
            self.scan(cursor=old_cursor)
        path.unlink()
        path.write_bytes(encoded(claude()))
        # Force a distinct inode while retaining the old one (inode reuse is
        # legal after unlink, so a replace fixture must not assume otherwise).
        replacement = path.with_suffix(".replacement")
        replacement.write_bytes(encoded(claude()))
        replacement.replace(path)
        with self.assertRaisesRegex(S.ScanError, "file-changed"):
            self.scan(cursor=old_cursor)

    def test_hard_link_does_not_reimport_same_source_bytes(self):
        path = self.fixture("codex", [codex()])
        os.link(path, self.codex_dir / "rollout-alias.jsonl")
        with self.assertRaisesRegex(S.ScanError, "file-changed"):
            self.scan("codex")

    def test_cursor_validation_rejects_unknown_paths_types_and_size(self):
        path = self.fixture("claude", [claude()])
        cursor = self.scan()["cursor"]
        for field, value in [("path", "../escape.jsonl"), ("offset", -1), ("device", "bad"),
                             ("anchor", "x"), ("totals", [1] * 1000), ("discarding", 1)]:
            bad = copy.deepcopy(cursor)
            bad["files"][0][field] = value
            with self.assertRaisesRegex(S.ScanError, "invalid-cursor"):
                S.validate_cursor(bad)
        with patch.object(S, "MAX_CURSOR_BYTES", 32):
            with self.assertRaisesRegex(S.ScanError, "invalid-cursor"):
                S.validate_cursor(cursor)

    def test_session_metadata_is_bounded_sanitized_and_cached(self):
        self.fixture("claude", [{"type": "user", "cwd": "/safe|dir\n", "message": {"content": "🐱" * 200}}, claude()])
        result = self.scan()
        item = result["cursor"]["files"][0]
        self.assertLessEqual(len(item["title"].encode("utf-16-le")) // 2, 160)
        self.assertEqual(item["cwd"], "/safe dir ")
        # Source removal does not force sessions to reread any agent record.
        self.claude_dir.rename(self.home / "gone")
        process, sessions = self.process("claude-sessions", result["cursor"])
        self.assertEqual(process.returncode, 0)
        self.assertEqual(sessions["cursor"], result["cursor"])
        self.assertEqual(len(sessions["rows"].split("|")), 6)

    def test_cli_uses_empty_environment_and_bounded_error_output(self):
        self.fixture("claude", [claude()])
        result, body = self.process()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(body["status"], "complete")
        proc = subprocess.run(["/usr/bin/python3", "-I", "-S", str(SCRIPT), "claude-usage", str(self.home)],
                              input=b"private synthetic contents\n", stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={})
        self.assertEqual(proc.returncode, 3)
        self.assertNotIn(b"private synthetic", proc.stdout + proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["reason"], "invalid-cursor")

    def test_private_process_group_no_children_and_term(self):
        proc = subprocess.Popen(["/usr/bin/python3", "-I", "-S", str(SCRIPT), "claude-usage", str(self.home)],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={})
        try:
            until = time.monotonic() + 3
            while os.getsid(proc.pid) != proc.pid and time.monotonic() < until:
                time.sleep(0.01)
            self.assertEqual(os.getsid(proc.pid), proc.pid)
            self.assertEqual(os.getpgid(proc.pid), proc.pid)
            self.assertEqual(Path(f"/proc/{proc.pid}/task/{proc.pid}/children").read_text().strip(), "")
            proc.send_signal(signal.SIGTERM)
            out, err = proc.communicate(timeout=2)
            self.assertEqual(proc.returncode, 3)
            self.assertEqual(err, b"")
            self.assertEqual(json.loads(out)["reason"], "cancelled")
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()

    def test_deadline_bounds_blocked_stdin_without_output_or_descendants(self):
        proc = subprocess.Popen(["/usr/bin/python3", "-I", "-S", str(SCRIPT), "claude-usage", str(self.home)],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={})
        started = time.monotonic()
        try:
            proc.wait(timeout=S.DEADLINE_SECONDS + 3)
            self.assertLess(time.monotonic() - started, S.DEADLINE_SECONDS + 2)
            self.assertEqual(proc.returncode, 3)
            out, err = proc.communicate()
            self.assertEqual(out + err, b"")
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()

    def test_deadline_also_bounds_blocked_stdout(self):
        # A valid >64KiB cursor makes output exceed a pipe's capacity. Keep
        # stdout unread and ensure the hard alarm still kills the sole worker.
        cursor = S.empty_cursor()
        cursor["seen"] = [S.digest(str(i).encode()) for i in range(2000)]
        proc = subprocess.Popen(["/usr/bin/python3", "-I", "-S", str(SCRIPT), "claude-usage", str(self.home)],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={})
        started = time.monotonic()
        try:
            proc.stdin.write((S.encode(cursor) + "\n").encode())
            proc.stdin.close()
            proc.stdin = None
            proc.wait(timeout=S.DEADLINE_SECONDS + 3)
            self.assertLess(time.monotonic() - started, S.DEADLINE_SECONDS + 2)
            self.assertEqual(proc.returncode, 3)
            out, err = proc.communicate()
            self.assertEqual(err, b"")
            self.assertLess(len(out), len(S.encode(cursor)))
            with self.assertRaises(ValueError):
                json.loads(out)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()

    def test_sigkill_reaps_the_only_process_group_member(self):
        proc = subprocess.Popen(["/usr/bin/python3", "-I", "-S", str(SCRIPT), "claude-usage", str(self.home)],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={})
        try:
            until = time.monotonic() + 3
            while os.getsid(proc.pid) != proc.pid and time.monotonic() < until:
                time.sleep(0.01)
            self.assertEqual(os.getpgid(proc.pid), proc.pid)
            os.killpg(proc.pid, signal.SIGKILL)
            proc.communicate(timeout=2)
            self.assertEqual(proc.returncode, -signal.SIGKILL)
            with self.assertRaises(ProcessLookupError):
                os.killpg(proc.pid, 0)
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()


if __name__ == "__main__":
    unittest.main(verbosity=2)
