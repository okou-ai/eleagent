#!/usr/bin/env python3
"""Check tracked source without installing models or starting application services."""
import ast
import json
import pathlib
import subprocess

root = pathlib.Path(__file__).resolve().parents[1]
files = subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode().split("\0")
checked = 0
for name in filter(None, files):
    path = root / name
    suffix = path.suffix
    if suffix == ".py":
        ast.parse(path.read_text(), filename=name)
    elif suffix in (".js", ".mjs"):
        subprocess.run(["node", "--check", str(path)], check=True)
    elif suffix in (".json", ".webmanifest"):
        json.loads(path.read_text())
    elif suffix == ".sh":
        subprocess.run(["bash", "-n", str(path)], check=True)
    else:
        continue
    checked += 1
print(f"Source syntax checked: {checked} files")
