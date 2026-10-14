"""
Background item mover (batch mode), using the inventory as a transfer buffer:

  per source tab:  switch once.
  priority moves:  shift-click in the stash (quickMove) - with tab priorities set, the game routes the
                   item straight to its priority tab (verified live), so a batch is just N requests.
  other moves:     (own rules / fallback) shift-click would follow priorities instead, so: cursor
                   stash -> inventory for the batch, then one tab switch per target tab and cursor drop.
  verify:          whole batch by item id against live game memory.

Anything that cannot be delivered stays in the inventory (safe) and the job stops with a message.

A move: {"id", "fromTab", "x", "y", "toTab", "tx", "ty", "name", "via": "priority" | "rule" | "fallback"}
Coordinates are game grid coordinates (origin bottom-left).
"""
import threading
import time

import log_setup

log = log_setup.get('mover')

STASH, INVENTORY = 21, 1


def find_in(items, item_id):
    return next((it for it in items if it.get('id') == item_id), None)


def where_is(snap, item_id):
    for c in snap['containers']:
        if find_in(c['items'], item_id):
            return c['index']
    return None


def occupied(items):
    cells = set()
    for it in items:
        for dx in range(it['w']):
            for dy in range(it['h']):
                cells.add((it['x'] + dx, it['y'] + dy))
    return cells


def fits(w_grid, h_grid, x, y, w, h, cells):
    if x < 0 or y < 0 or x + w > w_grid or y + h > h_grid:
        return False
    return all((x + dx, y + dy) not in cells for dx in range(w) for dy in range(h))


def free_spot(w_grid, h_grid, w, h, cells):
    for y in range(h_grid - h, -1, -1):  # top-left first (origin bottom-left)
        for x in range(w_grid - w + 1):
            if fits(w_grid, h_grid, x, y, w, h, cells):
                return x, y
    return None


def mark(cells, x, y, w, h):
    for dx in range(w):
        for dy in range(h):
            cells.add((x + dx, y + dy))


class MoveJob:
    def __init__(self, client, moves):
        self.client = client
        self.moves = moves
        self.state = 'queued'   # queued | running | done | stopped | failed
        self.done = 0
        self.skipped = 0
        self.log = []
        self.error = None
        self._cancel = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self._thread.start()
        return self

    def cancel(self):
        self._cancel.set()

    def status(self):
        return {'state': self.state, 'total': len(self.moves), 'done': self.done, 'skipped': self.skipped,
                'error': self.error, 'log': self.log[-200:]}

    # ------------------------------------------------------------------ helpers

    def _say(self, msg, kind='info'):
        self.log.append({'t': time.time(), 'kind': kind, 'msg': msg})
        (log.warning if kind == 'bad' else log.info)(msg)

    def _snap(self):
        return self.client.snapshot(True)

    def _wait(self, pred, timeout):
        end = time.time() + timeout
        snap = None
        while time.time() < end:
            snap = self._snap()
            if pred(snap):
                return snap, True
            time.sleep(0.08)
        return snap, False

    def _switch(self, tab):
        if self.client.snapshot(False)['activeTab'] == tab:
            return
        self.client.run('switchTab', {'tabId': tab}, delay_ms=30)
        _, ok = self._wait(lambda s: s['activeTab'] == tab, 2.0)
        if not ok:
            raise RuntimeError(f'could not switch to tab {tab}')

    def _return_cursor(self):
        if self.client.snapshot(False).get('cursorItem'):
            self.client.run('returnCursor', delay_ms=30)
            self._wait(lambda s: s['cursorItem'] is None, 3.0)

    def _check_ready(self):
        snap = self.client.snapshot(False)
        if self._cancel.is_set():
            raise _Stop('Cancelled.')
        if not snap.get('stashOpen'):
            raise _Stop('Stopped: stash closed in game.')
        if snap.get('cursorItem'):
            raise RuntimeError('cursor holds an item - put it down in game')

    # ------------------------------------------------------------------ run

    def _run(self):
        self.state = 'running'
        log.info('move job started: %d moves', len(self.moves))
        try:
            groups = {}
            for m in self.moves:
                groups.setdefault(m['fromTab'], []).append(m)
            for src, group in groups.items():
                while group:
                    self._check_ready()
                    group = self._batch(src, group)
            self.state = 'done'
            self._say(f'Finished: {self.done} moved, {self.skipped} skipped.', 'ok')
        except _Stop as e:
            self.state = 'stopped'
            self._say(str(e), 'bad')
        except Exception as e:  # earlier moves stay applied; leftovers are in the inventory
            log.exception('move job failed after %d moves', self.done)
            self.state = 'failed'
            self.error = str(e)
            self._say(f'Stopped: {e}', 'bad')

    def _batch(self, src, group):
        """Move items of `group` (all from tab `src`) through the inventory. Returns moves that did not fit."""
        snap = self._snap()
        present = []
        for m in group:
            it = find_in(snap['containers'][src]['items'], m['id'])
            if it:
                present.append((m, it))
            else:
                self.skipped += 1
                self._say(f"skip {m['name']}: no longer in its tab")
        if not present:
            return []

        # take as many as fit into the free inventory space (simulated)
        inv_w, inv_h = snap.get('inventorySize') or (12, 5)
        cells = occupied(snap['inventory'])
        take, rest_moves = [], []
        for m, it in present:
            spot = None if rest_moves else free_spot(inv_w, inv_h, it['w'], it['h'], cells)
            if spot is None:
                rest_moves.append(m)
                continue
            mark(cells, *spot, it['w'], it['h'])
            take.append((m, it, spot))
        if not take:
            raise RuntimeError('inventory is full - free some inventory space')

        self._switch(src)
        # 1) stash -> inventory. Priority moves: shift-click. Rule/fallback moves: cursor to the simulated
        #    spot (same result, keeps our spot bookkeeping exact).
        calls = []
        for m, it, spot in take:
            if m.get('via') == 'priority':
                calls.append(('quickMove', {'src': STASH, 'dst': INVENTORY, 'x': it['x'], 'y': it['y']}))
            else:
                calls += [('pickup', {'container': STASH, 'x': it['x'], 'y': it['y']}),
                          ('drop', {'container': INVENTORY, 'x': spot[0], 'y': spot[1]})]
        self.client.run_batch(calls)
        ids = [m['id'] for m, _, _ in take]
        snap, _ = self._wait(lambda s: s['cursorItem'] is None and all(find_in(s['inventory'], i) for i in ids), 5.0)
        self._return_cursor()
        in_inv = [m for m, _, _ in take if find_in(snap['inventory'], m['id'])]
        for m, _, _ in take:
            if m not in in_inv:
                self.skipped += 1
                self._say(f"skip {m['name']}: could not take it out of tab {src}")
        self._say(f'tab {src}: {len(in_inv)} items in inventory')

        # 2) priority moves: shift-click inventory -> stash, the game routes each to its priority tab
        pri = [m for m in in_inv if m.get('via') == 'priority']
        if pri:
            self.client.run_batch([('quickMove', {'src': INVENTORY, 'dst': STASH,
                                                  'x': find_in(snap['inventory'], m['id'])['x'],
                                                  'y': find_in(snap['inventory'], m['id'])['y']}) for m in pri])
            snap, _ = self._wait(lambda s: not any(find_in(s['inventory'], m['id']) for m in pri), 6.0)
            for m in pri:
                tab = where_is(snap, m['id'])
                if tab is None:
                    continue  # no priority tab took it -> cursor delivery below
                self.done += 1
                self._say(f"moved {m['name']} -> tab {tab}" + ('' if tab == m['toTab'] else f" (game's choice; planned {m['toTab']})"), 'ok')

        # everything still in the inventory goes by cursor to its planned tab
        carry = [m for m in in_inv if find_in(snap['inventory'], m['id'])]

        # 3) deliver carried items: one tab switch per target tab
        by_target = {}
        for m in carry:
            by_target.setdefault(m['toTab'], []).append(m)
        for tab, ms in by_target.items():
            self._check_ready()
            self._switch(tab)
            for m in ms:
                snap = self._snap()
                inv_it = find_in(snap['inventory'], m['id'])
                dst = snap['containers'][tab]
                cells = occupied(dst['items'])
                if fits(dst['w'], dst['h'], m['tx'], m['ty'], inv_it['w'], inv_it['h'], cells):
                    tx, ty = m['tx'], m['ty']
                else:
                    spot = free_spot(dst['w'], dst['h'], inv_it['w'], inv_it['h'], cells)
                    if not spot:
                        raise RuntimeError(f"tab {tab} is full - {m['name']} left in inventory")
                    tx, ty = spot
                self.client.run_batch([('pickup', {'container': INVENTORY, 'x': inv_it['x'], 'y': inv_it['y']}),
                                       ('drop', {'container': STASH, 'x': tx, 'y': ty})])
                _, ok = self._wait(lambda s: s['cursorItem'] is None
                                   and (find_in(s['containers'][tab]['items'], m['id']) or {}).get('x') == tx, 3.0)
                if not ok:
                    self._return_cursor()
                    raise RuntimeError(f"could not drop {m['name']} into tab {tab} (it is in your inventory)")
                self.done += 1
                self._say(f"moved {m['name']} -> tab {tab}", 'ok')
        return rest_moves


class _Stop(Exception):
    pass
