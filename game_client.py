"""Frida bridge to the StashManager agent running inside Last Epoch."""
import os
import threading
import time

import frida

import log_setup

log = log_setup.get('game')

AGENT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'agent', 'agent.js')
PROCESS_NAME = 'Last Epoch.exe'


class GameClient:
    def __init__(self):
        self._session = None
        self._script = None
        self._lock = threading.Lock()

    @property
    def attached(self):
        return self._script is not None

    def attach(self):
        with open(AGENT_PATH, encoding='utf-8') as fh:
            source = fh.read()
        self._session = frida.attach(PROCESS_NAME)
        self._session.on('detached', self._on_detached)
        self._script = self._session.create_script(source)
        self._script.on('message', self._on_message)
        self._script.load()
        log.info('attached to %s, agent loaded', PROCESS_NAME)

    def detach(self):
        if self._script:
            try:
                self._script.exports_sync.dispose()  # drop the Update hook first
            except Exception:
                pass
            try:
                self._script.unload()
                self._session.detach()
            except frida.InvalidOperationError:
                pass
        self._script = self._session = None

    def _on_detached(self, reason, crash):
        log.warning('detached from game: %s%s', reason, f' (crash: {crash.summary})' if crash else '')
        self._script = self._session = None

    @staticmethod
    def _on_message(message, data):
        if message.get('type') == 'error':
            log.error('agent error: %s', message.get('stack') or message.get('description'))

    @property
    def api(self):
        if not self._script:
            raise RuntimeError('not attached to game')
        return self._script.exports_sync

    def snapshot(self, with_items=True):
        with self._lock:
            return self.api.snapshot(with_items)

    def game_data(self):
        with self._lock:
            return self.api.game_data()

    def state(self):
        with self._lock:
            return self.api.state()

    def run(self, op, args=None, delay_ms=150, timeout=5.0):
        """Queue an op for the main thread and wait for its result."""
        with self._lock:
            cmd_id = self.api.enqueue(op, args or {}, delay_ms)
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                res = self.api.result(cmd_id)
            if res is not None:
                if not res['ok']:
                    log.warning('op %s failed: %s | args %s', op, res['error'], str(args)[:300])
                    raise RuntimeError(f'{op} failed: {res["error"]}')
                return res['value']
            time.sleep(0.02)
        log.warning('op %s timed out after %ss (game paused / minimized?)', op, timeout)
        raise TimeoutError(f'{op} not executed (game paused / alt-tabbed?)')

    def run_batch(self, calls, delay_ms=40, timeout=30.0):
        """Queue many (op, args) at once (executed one per game frame) and wait for all results."""
        with self._lock:
            ids = [self.api.enqueue(op, args or {}, delay_ms) for op, args in calls]
        results, deadline = {}, time.time() + timeout
        while len(results) < len(ids) and time.time() < deadline:
            with self._lock:
                for i in ids:
                    if i not in results:
                        r = self.api.result(i)
                        if r is not None:
                            results[i] = r
            time.sleep(0.02)
        return [results.get(i) for i in ids]

    def wait_for(self, predicate, timeout=3.0, with_items=True):
        """Poll snapshots until predicate(snapshot) is truthy (server round trip)."""
        deadline = time.time() + timeout
        snap = None
        while time.time() < deadline:
            snap = self.snapshot(with_items)
            if predicate(snap):
                return snap
            time.sleep(0.1)
        return None
