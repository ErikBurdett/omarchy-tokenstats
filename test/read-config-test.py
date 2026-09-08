#!/usr/bin/python3
"""Adversarial producer-bound tests; only isolated temporary files are used."""

import importlib.util
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "read-config.py"
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("read_config", SCRIPT)
READER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(READER)


class ConfigReaderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="tokenstats-config-test-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.config = self.root / "opencode.json"

    def run_reader(self, path=None):
        return subprocess.run(
            ["/usr/bin/python3", "-I", "-S", str(SCRIPT), str(path or self.config)],
            env={}, capture_output=True, timeout=5, check=False,
        )

    def assert_rejected(self, path=None):
        result = self.run_reader(path)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")
        self.assertLessEqual(len(result.stderr), 100)

    def test_valid_config_preserves_original_bytes(self):
        payload = json.dumps({"provider": {"local": {"options": {"baseURL": "http://127.0.0.1:8080/v1"}}}}).encode()
        self.config.write_bytes(payload)
        result = self.run_reader()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, payload)
        self.assertEqual(result.stderr, b"")

    def test_exact_limit_accepted_and_extra_byte_rejected(self):
        self.config.write_bytes(b"{}" + b" " * (READER.MAX_BYTES - 2))
        result = self.run_reader()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(len(result.stdout), READER.MAX_BYTES)
        with self.config.open("ab") as file:
            file.write(b" ")
        self.assert_rejected()

    def test_sparse_oversize_rejected_without_allocating_its_size(self):
        with self.config.open("wb") as file:
            file.truncate(1024 * 1024 * 1024)
        self.assert_rejected()

    def test_fifo_rejected_without_waiting_for_writer(self):
        os.mkfifo(self.config)
        self.assert_rejected()

    def test_symlink_leaf_rejected(self):
        target = self.root / "target.json"
        target.write_text("{}")
        self.config.symlink_to(target)
        self.assert_rejected()

    def test_symlink_parent_rejected(self):
        target = self.root / "real"
        target.mkdir()
        (target / "config.json").write_text("{}")
        alias = self.root / "alias"
        alias.symlink_to(target, target_is_directory=True)
        self.assert_rejected(alias / "config.json")

    def test_invalid_json_and_nonobject_rejected_without_content_disclosure(self):
        for payload in (b"", b"private-key-secret", b"[]", b"null", b'{"n":NaN}', b'{"n":1e999}', b"\xff"):
            with self.subTest(payload=payload):
                self.config.write_bytes(payload)
                self.assert_rejected()

    def test_excessive_json_nesting_rejected(self):
        self.config.write_bytes(b'{"a":' + b"[" * 3000 + b"0" + b"]" * 3000 + b"}")
        self.assert_rejected()

    def test_excessive_value_count_rejected(self):
        self.config.write_text(json.dumps({"values": [0] * READER.MAX_JSON_VALUES}))
        self.assert_rejected()

    def test_hard_deadline_also_bounds_blocked_stdout(self):
        self.config.write_bytes(b"{}" + b" " * (READER.MAX_BYTES - 2))
        with subprocess.Popen(
            ["/usr/bin/python3", "-I", "-S", str(SCRIPT), str(self.config)],
            env={}, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        ) as process:
            fcntl.fcntl(process.stdout.fileno(), fcntl.F_SETPIPE_SZ, 4096)
            try:
                self.assertEqual(process.wait(timeout=5), 124)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
            self.assertLessEqual(len(process.stdout.read()), READER.MAX_BYTES)

    def test_directory_missing_relative_and_dotdot_paths_rejected(self):
        self.assert_rejected(self.root)
        self.assert_rejected()
        self.assert_rejected("relative.json")
        self.assert_rejected(str(self.root) + "/../config.json")

    def test_owner_check_uses_opened_descriptor(self):
        self.config.write_text("{}")
        actual_fstat = os.fstat

        def other_owner(fd):
            info = actual_fstat(fd)
            values = list(info)
            values[4] = info.st_uid + 1
            return os.stat_result(values)

        with mock.patch.object(READER.os, "fstat", side_effect=other_owner):
            with self.assertRaises(READER.RejectedConfig):
                READER.read_config(str(self.config))

    def test_growth_after_fstat_is_still_bounded(self):
        self.config.write_text("{}")
        original_read = os.read
        enlarged = False
        requested = []

        def grow_then_read(fd, size):
            nonlocal enlarged
            if not enlarged:
                with self.config.open("ab") as file:
                    file.write(b" " * READER.MAX_BYTES)
                enlarged = True
            requested.append(size)
            return original_read(fd, size)

        with mock.patch.object(READER.os, "read", side_effect=grow_then_read):
            with self.assertRaises(READER.RejectedConfig):
                READER.read_config(str(self.config))
        self.assertLessEqual(sum(requested), READER.MAX_BYTES + 1)


if __name__ == "__main__":
    unittest.main()
