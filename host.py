"""
StashManager local web host.

    python host.py            -> http://127.0.0.1:8100

Binds to localhost only. Write ops go through /api/op; tab purchase needs "confirm": true.
"""
import json
import os
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from game_client import GameClient  # noqa: E402
from mover import MoveJob  # noqa: E402
import prices  # noqa: E402

HOST, PORT = '127.0.0.1', 8100
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'web')
ICONS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'icons')
RULES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'rules.json')
PRESETS_BUILTIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'presets')
PRESETS_USER = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'presets')
TABSTYLES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'tabstyles.json')
GAMEDATA_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'gamedata.json')

# ops the web UI may run; everything else is rejected
ALLOWED_OPS = {
    'switchTab', 'pickup', 'drop', 'returnCursor', 'quickMove', 'sortTab',
    'categoryCreate', 'categoryConfigure', 'categoryDelete', 'categoryReorder',
    'tabConfigure', 'tabReorder', 'tabPurchase', 'nextTabCost', 'tabCosts', 'tabStyles',
}
NEEDS_CONFIRM = {'tabPurchase', 'categoryDelete', 'sortTab'}

client = GameClient()
attach_lock = threading.Lock()
gamedata_cache = None
job = None  # current MoveJob


def load_gamedata(refresh=False):
    """Bases/subtypes/uniques/affixes from game memory; cached on disk (changes only on patch)."""
    global gamedata_cache
    ensure_attached()
    build = client.state().get('build')  # GameAssembly.dll size: changes with every game patch
    if gamedata_cache and gamedata_cache.get('build') == build and not refresh:
        return gamedata_cache
    if not refresh and os.path.exists(GAMEDATA_PATH):
        with open(GAMEDATA_PATH, encoding='utf-8') as fh:
            cached = json.load(fh)
        if cached.get('build') == build:
            gamedata_cache = cached
            return cached
    data = client.game_data()
    if not data.get('ok'):
        client.run('loadMasterLists')
        data = client.game_data()
    if not data.get('ok'):
        raise RuntimeError(f'game data not available: {data.get("missing")}')
    os.makedirs(os.path.dirname(GAMEDATA_PATH), exist_ok=True)
    with open(GAMEDATA_PATH, 'w', encoding='utf-8') as fh:
        json.dump(data, fh)
    gamedata_cache = data
    return data


def ensure_attached():
    with attach_lock:
        if not client.attached:
            client.attach()


def load_tabstyles():
    """Tab colour palette + icon names. Only readable while the stash panel exists -> cached on disk."""
    if os.path.exists(TABSTYLES_PATH):
        with open(TABSTYLES_PATH, encoding='utf-8') as fh:
            return json.load(fh)
    ensure_attached()
    if not client.state().get('stashOpen'):
        return {'ok': False, 'error': 'open the stash once to read tab colours/icons'}
    data = client.run('tabStyles', timeout=10)
    data['ok'] = True
    with open(TABSTYLES_PATH, 'w', encoding='utf-8') as fh:
        json.dump(data, fh)
    return data


def preset_file(name):
    safe = ''.join(ch if ch.isalnum() or ch in ' _-' else '_' for ch in name).strip() or 'preset'
    return os.path.join(PRESETS_USER, safe + '.json')


def list_presets():
    out = []
    for folder, builtin in ((PRESETS_BUILTIN, True), (PRESETS_USER, False)):
        if not os.path.isdir(folder):
            continue
        for fn in sorted(os.listdir(folder)):
            if fn.endswith('.json'):
                with open(os.path.join(folder, fn), encoding='utf-8') as fh:
                    p = json.load(fh)
                p['builtin'] = builtin
                out.append(p)
    return out


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    def log_message(self, fmt, *args):
        if not self.path.startswith('/api/op'):  # polling endpoints are too chatty
            return
        sys.stderr.write('%s\n' % (fmt % args))

    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _icon(self):
        name = os.path.basename(self.path.split('?')[0])
        path = os.path.join(ICONS_DIR, name)
        if not os.path.isfile(path):
            return self._json(404, {'error': 'no icon'})
        with open(path, 'rb') as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json' if name.endswith('.json') else 'image/png')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'max-age=86400')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith('/icons/'):
            return self._icon()
        if not self.path.startswith('/api/'):
            return super().do_GET()
        if self.path.startswith('/api/presets'):  # works without the game
            return self._json(200, list_presets())
        if self.path.startswith('/api/rules'):
            if not os.path.exists(RULES_PATH):
                return self._json(200, [])
            with open(RULES_PATH, encoding='utf-8') as fh:
                return self._json(200, json.load(fh))
        if self.path.startswith('/api/prices'):  # external feed, works without the game
            try:
                from urllib.parse import urlparse, parse_qs
                q = parse_qs(urlparse(self.path).query)
                return self._json(200, prices.load(q.get('cycle', [None])[0]))
            except Exception as e:
                return self._json(503, {'ok': False, 'error': str(e)})
        if self.path.startswith('/api/job'):
            return self._json(200, job.status() if job else {'state': 'none'})
        try:
            ensure_attached()
            if self.path == '/api/state':
                return self._json(200, client.state())
            if self.path.startswith('/api/tabstyles'):
                return self._json(200, load_tabstyles())
            if self.path.startswith('/api/gamedata'):
                return self._json(200, load_gamedata(refresh='refresh=1' in self.path))
            if self.path.startswith('/api/snapshot'):
                return self._json(200, client.snapshot(True))
            return self._json(404, {'error': 'unknown endpoint'})
        except Exception as e:  # game not running, detached, etc.
            client.detach()
            return self._json(503, {'error': str(e)})

    def do_POST(self):
        if self.path not in ('/api/op', '/api/preset-save', '/api/preset-delete', '/api/rules-save',
                             '/api/job-start', '/api/job-cancel'):
            return self._json(404, {'error': 'unknown endpoint'})
        # reject cross-site requests (page must be served from this host)
        origin = self.headers.get('Origin')
        if origin and origin not in (f'http://{HOST}:{PORT}', f'http://localhost:{PORT}'):
            return self._json(403, {'error': 'bad origin'})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
            global job
            if self.path == '/api/rules-save':
                rules = req.get('rules')
                if not isinstance(rules, list):
                    return self._json(400, {'error': 'rules must be a list'})
                os.makedirs(os.path.dirname(RULES_PATH), exist_ok=True)
                with open(RULES_PATH, 'w', encoding='utf-8') as fh:
                    json.dump(rules, fh, indent=1)
                return self._json(200, {'ok': True})
            if self.path == '/api/job-cancel':
                if job:
                    job.cancel()
                return self._json(200, {'ok': True})
            if self.path == '/api/job-start':
                if job and job.state in ('queued', 'running'):
                    return self._json(409, {'error': 'a job is already running'})
                moves = req.get('moves')
                if not isinstance(moves, list) or not moves or not req.get('confirm'):
                    return self._json(400, {'error': 'needs moves and confirm'})
                ensure_attached()
                if not client.state().get('stashOpen'):
                    return self._json(409, {'error': 'stash is not open in game'})
                job = MoveJob(client, moves).start()
                return self._json(200, {'ok': True})
            if self.path == '/api/preset-save':
                preset = req.get('preset') or {}
                if not preset.get('name') or not isinstance(preset.get('folders'), list):
                    return self._json(400, {'error': 'preset needs name and folders'})
                preset.pop('builtin', None)
                os.makedirs(PRESETS_USER, exist_ok=True)
                with open(preset_file(preset['name']), 'w', encoding='utf-8') as fh:
                    json.dump(preset, fh, indent=1)
                return self._json(200, {'ok': True})
            if self.path == '/api/preset-delete':
                path = preset_file(req.get('name', ''))
                if os.path.exists(path):
                    os.remove(path)
                return self._json(200, {'ok': True})
            op, args = req.get('op'), req.get('args') or {}
            if op not in ALLOWED_OPS:
                return self._json(400, {'error': f'op not allowed: {op}'})
            if op in NEEDS_CONFIRM and not req.get('confirm'):
                return self._json(409, {'error': f'{op} needs confirm'})
            ensure_attached()
            if not client.state().get('stashOpen'):
                return self._json(409, {'error': 'stash is not open in game'})
            return self._json(200, {'ok': True, 'value': client.run(op, args)})
        except Exception as e:
            return self._json(500, {'error': str(e)})


def main():
    try:
        ensure_attached()
        print('[+] attached to Last Epoch')
    except Exception as e:
        print(f'[!] not attached yet ({e}); will retry on first request')
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f'[+] http://{HOST}:{PORT}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        client.detach()


if __name__ == '__main__':
    main()
