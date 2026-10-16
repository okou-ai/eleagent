"""Cooperative GPU handoff, acknowledged only at an inference-free boundary."""
import os
import json
from pathlib import Path
import uuid


class NightPause:
    def __init__(self, worker, directory='/data'):
        self.worker = worker
        self.marker = Path(directory) / 'night-gpu.pause'
        self.ack = Path(directory) / ('night-gpu.' + worker + '.paused')
        self.ready_file = Path(directory) / ('night-gpu.' + worker + '.ready')
        # A previous process's acknowledgement cannot describe this process.
        self.clear()
        self.ready_file.unlink(missing_ok=True)

    def publish_ready(self):
        """Called once, after this process has loaded every required model."""
        temporary = self.ready_file.with_suffix(self.ready_file.suffix + '.tmp')
        with temporary.open('w') as output:
            os.fchmod(output.fileno(), 0o600)
            json.dump({'worker': self.worker, 'pid': os.getpid()}, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, self.ready_file)

    def clear(self):
        self.ack.unlink(missing_ok=True)

    def paused(self, idle=True):
        try:
            lease = self.marker.read_text().strip()
        except FileNotFoundError:
            self.clear()
            return False
        try:
            valid = str(uuid.UUID(lease)) == lease
        except ValueError:
            valid = False
        if not valid or not idle:
            self.clear()
            return True
        try:
            acknowledged = self.ack.read_text().strip() == lease
        except FileNotFoundError:
            acknowledged = False
        if not acknowledged:
            temporary = self.ack.with_suffix(self.ack.suffix + '.tmp')
            with temporary.open('w') as output:
                os.fchmod(output.fileno(), 0o600)
                output.write(lease + '\n')
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.ack)
        # The manager may have released or replaced the lease during the write.
        try:
            still_owned = self.marker.read_text().strip() == lease
        except FileNotFoundError:
            still_owned = False
        if not still_owned:
            self.clear()
        return True
