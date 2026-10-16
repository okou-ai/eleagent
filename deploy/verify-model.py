#!/usr/bin/env python3
"""Verify a local model against pinned public metadata without downloading weights."""

import argparse
import fnmatch
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys
import urllib.parse
import urllib.request


SCHEMA = "eleagent.hf-tree/v1"


def fetch_metadata(model):
    prefix = f"https://huggingface.co/api/models/{model['repo_id']}/tree/{model['revision']}"
    url = prefix + "?recursive=true&expand=false&limit=1000"
    files = []
    seen = set()
    while url:
        if url in seen or len(seen) >= 100 or not url.startswith(prefix + "?"):
            raise ValueError("Unexpected metadata pagination URL")
        seen.add(url)
        with urllib.request.urlopen(url, timeout=30) as response:
            files.extend(json.load(response))
            links = response.headers.get("Link", "")
        match = re.search(r'<([^>]+)>;\s*rel="next"', links)
        url = match.group(1) if match else None
    return {"schema": SCHEMA, "repo_id": model["repo_id"],
            "revision": model["revision"], "files": files}


def metadata_files(model, metadata):
    if (metadata.get("schema") != SCHEMA or metadata.get("repo_id") != model["repo_id"]
            or metadata.get("revision") != model["revision"]):
        raise ValueError("Metadata does not match the model's pinned repository and revision")
    files = {}
    for entry in metadata["files"]:
        if entry.get("type") != "file":
            continue
        name = entry["path"]
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or str(path) != name or name in files:
            raise ValueError("Unsafe or duplicate metadata path")
        lfs = entry.get("lfs")
        digest = lfs["oid"] if lfs else entry["oid"]
        if not re.fullmatch(r"[0-9a-f]{64}" if lfs else r"[0-9a-f]{40}", digest):
            raise ValueError(f"Invalid upstream hash for {name}")
        if type(entry["size"]) is not int or entry["size"] < 0:
            raise ValueError(f"Invalid upstream size for {name}")
        files[name] = (entry["size"], digest, bool(lfs))
    if not files:
        raise ValueError("Metadata contains no files")
    return files


def verify(model, directory, metadata):
    result = {"model": model["id"], "repo_id": model["repo_id"],
              "revision": model["revision"], "verified_files": 0,
              "verified_bytes": 0, "optional_missing": [], "failures": []}
    optional = model.get("optional_file_patterns", [])
    for name, (size, expected, lfs) in metadata_files(model, metadata).items():
        path = directory / name
        if not path.is_file():
            if any(fnmatch.fnmatchcase(name, pattern) for pattern in optional):
                result["optional_missing"].append(name)
            else:
                result["failures"].append({"path": name, "reason": "missing"})
            continue
        if path.stat().st_size != size:
            result["failures"].append({"path": name, "reason": "size_mismatch"})
            continue
        digest = hashlib.sha256() if lfs else hashlib.sha1()
        if not lfs:
            digest.update(f"blob {size}\0".encode())
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            result["failures"].append({"path": name, "reason": "hash_mismatch"})
            continue
        result["verified_files"] += 1
        result["verified_bytes"] += size
    result["ok"] = not result["failures"]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model_id", help="A Hugging Face model ID from models.lock.json")
    parser.add_argument("--path", type=Path, required=True, help="Existing local model directory")
    parser.add_argument("--metadata-file", type=Path, help="Previously saved pinned metadata; disables network access")
    parser.add_argument("--write-metadata", type=Path, help="Save fetched metadata for later offline checks")
    args = parser.parse_args()
    manifest = json.loads(Path(__file__).with_name("models.lock.json").read_text())
    model = next((m for m in manifest["models"] if m["id"] == args.model_id), None)
    if model is None or model.get("provider") != "huggingface":
        parser.error("Choose a model with provider=huggingface in models.lock.json")
    if not args.path.is_dir():
        parser.error("--path must be an existing model directory")
    try:
        metadata = json.loads(args.metadata_file.read_text()) if args.metadata_file else fetch_metadata(model)
        metadata_files(model, metadata)
        if args.write_metadata:
            with args.write_metadata.open("x") as output:
                json.dump(metadata, output, indent=2)
                output.write("\n")
        result = verify(model, args.path, metadata)
        print(json.dumps(result, indent=2))
        return 0 if result["ok"] else 1
    except (ValueError, KeyError, OSError) as error:
        print(f"Model verification failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
