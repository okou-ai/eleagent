"""Model integrity checks use synthetic bytes and never download weights."""

import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("verify_model", Path(__file__).parents[1] / "verify-model.py")
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class ModelVerificationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.model = {"id": "synthetic", "repo_id": "example/synthetic", "revision": "a" * 40,
                      "optional_file_patterns": ["examples/*.mp4"]}
        self.metadata = {"schema": verifier.SCHEMA, "repo_id": self.model["repo_id"],
                         "revision": self.model["revision"], "files": []}
        for name, data, lfs in [("config.json", b'{"layers":1}', False),
                                ("model.safetensors", b"synthetic weight bytes", True),
                                ("examples/demo.mp4", b"optional example", True)]:
            entry = {"type": "file", "path": name, "size": len(data)}
            if lfs:
                entry["lfs"] = {"oid": hashlib.sha256(data).hexdigest()}
            else:
                entry["oid"] = hashlib.sha1(f"blob {len(data)}\0".encode() + data).hexdigest()
            self.metadata["files"].append(entry)
            if not name.startswith("examples/"):
                (self.root / name).write_bytes(data)

    def test_lfs_and_git_blob_bytes_are_checked_and_only_documented_examples_are_optional(self):
        result = verifier.verify(self.model, self.root, self.metadata)
        self.assertTrue(result["ok"])
        self.assertEqual(result["verified_files"], 2)
        self.assertEqual(result["optional_missing"], ["examples/demo.mp4"])

    def test_same_size_modified_configuration_is_rejected(self):
        (self.root / "config.json").write_bytes(b'{"layers":9}')
        result = verifier.verify(self.model, self.root, self.metadata)
        self.assertFalse(result["ok"])
        self.assertIn({"path": "config.json", "reason": "hash_mismatch"}, result["failures"])

    def test_missing_weight_is_never_accepted_as_an_optional_example(self):
        (self.root / "model.safetensors").unlink()
        result = verifier.verify(self.model, self.root, self.metadata)
        self.assertFalse(result["ok"])
        self.assertIn({"path": "model.safetensors", "reason": "missing"}, result["failures"])

    def test_wrong_revision_and_path_traversal_are_rejected(self):
        self.metadata["revision"] = "b" * 40
        with self.assertRaises(ValueError):
            verifier.verify(self.model, self.root, self.metadata)
        self.metadata["revision"] = self.model["revision"]
        self.metadata["files"][0]["path"] = "../config.json"
        with self.assertRaises(ValueError):
            verifier.verify(self.model, self.root, self.metadata)
