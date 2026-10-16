#!/usr/bin/env python3
"""Install a hashed lock, reusing matching local artifacts when available."""

import pathlib
import re
import subprocess
import sys
import tempfile
import urllib.parse


def install(lock_path, wheelhouse, extra_args):
    lock = pathlib.Path(lock_path)
    cache = pathlib.Path(wheelhouse).resolve()
    reused = set()

    def local_url(match):
        url = match.group(0)
        parsed = urllib.parse.urlsplit(url)
        filename = pathlib.PurePosixPath(urllib.parse.unquote(parsed.path)).name
        candidate = cache / filename
        if not candidate.is_file():
            return url
        # Keep the lock's hashes; pip validates the cached artifact before use.
        reused.add(filename)
        return candidate.as_uri() + ("#" + parsed.fragment if parsed.fragment else "")

    content = re.sub(r"https?://[^\s\\]+", local_url, lock.read_text())
    with tempfile.NamedTemporaryFile(mode="w", suffix=".lock") as generated:
        generated.write(content)
        generated.flush()
        print(f"Reusing {len(reused)} checksum-pinned local artifacts", flush=True)
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--no-deps", "--require-hashes",
             f"--find-links={cache}", *extra_args, "-r", generated.name],
            check=True,
        )


if __name__ == "__main__":
    install(sys.argv[1], sys.argv[2], sys.argv[3:])
