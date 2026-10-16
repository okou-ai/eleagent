"""Install a lock file, optionally reusing exact PyTorch packages in a trusted base."""
import argparse
import importlib.metadata
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.parse import unquote, urlparse

TORCH_PACKAGES = {'torch', 'torchvision', 'torchaudio'}


def reuse_torch(lines):
    result = []
    seen = set()
    for line in lines:
        name, separator, url = line.partition(' @ ')
        if separator and name in TORCH_PACKAGES:
            filename = unquote(Path(urlparse(url).path).name)
            wheel_name, version, *_ = filename.split('-')
            if wheel_name != name or not filename.endswith('.whl'):
                raise ValueError(f'Unexpected wheel URL for {name}')
            installed = importlib.metadata.version(name)
            if installed != version:
                raise ValueError(f'{name}: cached version {installed} does not match {version}')
            result.append(f'{name}=={version}')
            seen.add(name)
        else:
            result.append(line)
    if seen != TORCH_PACKAGES:
        raise ValueError('The lock must contain all three pinned PyTorch wheel URLs')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('lock', type=Path)
    args = parser.parse_args()
    reuse = os.environ.get('REUSE_INSTALLED_TORCH', '0')
    if reuse not in {'0', '1'}:
        raise ValueError('REUSE_INSTALLED_TORCH must be 0 or 1')
    if reuse == '0':
        subprocess.run([sys.executable, '-m', 'pip', 'install', '--no-cache-dir', '-r', str(args.lock)], check=True)
        return
    lines = reuse_torch(args.lock.read_text().splitlines())
    with tempfile.TemporaryDirectory(prefix='eleagent-dependencies-') as directory:
        lock = Path(directory) / args.lock.name
        lock.write_text('\n'.join(lines) + '\n')
        subprocess.run([sys.executable, '-m', 'pip', 'install', '--no-cache-dir', '-r', str(lock)], check=True)


if __name__ == '__main__':
    main()
