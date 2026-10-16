#!/usr/bin/env python3
"""Return 0 when workers have drained the current lease; never run inference."""
import argparse
from datetime import datetime
import json
from pathlib import Path
import subprocess
import urllib.request
import uuid


def running_containers(names):
    result = subprocess.run(['docker', 'inspect', *names], capture_output=True,
                            text=True, check=True, timeout=5)
    rows = json.loads(result.stdout)
    by_name = {row['Name'].lstrip('/'): row for row in rows}
    if set(by_name) != set(names):
        raise ValueError('container_identity')
    for row in rows:
        state = row['State']
        if not state['Running'] or state.get('Paused') or state.get('Restarting'):
            raise ValueError('container_not_running')
    return by_name


def minicpm_idle(url):
    # Bypass ambient HTTP proxies for a host-configured internal health endpoint.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=5) as response:
        state = json.load(response)
    return (state.get('status') == 'healthy' and state.get('worker_status') == 'idle'
            and state.get('model_loaded') is True)


def drained(config):
    directory = Path(config['data_dir'])
    marker = directory / 'night-gpu.pause'
    lease = marker.read_text().strip()
    if str(uuid.UUID(lease)) != lease:
        return False
    workers = config['pause_workers']
    if not workers:
        return False
    containers = running_containers(list(workers.values()))
    for worker, name in workers.items():
        ack = directory / ('night-gpu.' + worker + '.paused')
        started = datetime.fromisoformat(containers[name]['State']['StartedAt'].replace('Z', '+00:00')).timestamp()
        if ack.read_text().strip() != lease or ack.stat().st_mtime < started:
            return False
    if config['host_role'] == 's1' and not minicpm_idle(config['minicpm_health_url']):
        return False
    # An intervening release or replacement invalidates acknowledgements.
    return marker.read_text().strip() == lease


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    try:
        config = json.loads(Path(args.config).read_text())
        ready = config['host_role'] in {'s1', 's2'} and drained(config)
    except Exception:
        ready = False
    raise SystemExit(0 if ready else 1)


if __name__ == '__main__':
    main()
