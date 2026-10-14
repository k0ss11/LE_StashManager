"""
StashManager local web host.

    python host.py                  -> http://127.0.0.1:8100 (this PC only)
    python host.py --lan            -> also reachable from other devices in your network
    python host.py --host 192.168.1.20 [--port 8100]

Requests from this PC need nothing. Requests from any other device need the access key: open the
link printed at start once (it sets a cookie). Key is kept in data/lan_key.txt (--new-key to change).
Write ops go through /api/op; tab purchase needs "confirm": true.
"""
import argparse
import json
import os
import secrets
import socket
import sys
import threading
from http.cookies import SimpleCookie
from urllib.parse import parse_qs, urlparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import log_setup  # noqa: E402
from game_client import GameClient  # noqa: E402
from mover import MoveJob  # noqa: E402
import prices  # noqa: E402

HOST, PORT = '127.0.0.1', 8100
LAN_KEY_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'lan_key.txt')
LAN_KEY = None  # set in main(); required for requests not coming from this PC
LOOPBACK = ('127.0.0.1', '::1', '::ffff:127.0.0.1')
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

log = log_setup.get('host')
client = GameClient()
attach_lock = threading.Lock()
gamedata_cache = None
job = None  # current MoveJob
icons_job = {'state': 'none', 'log': []}  # item art extraction (tools/extract_icons.py)


def icons_status():
    have = os.path.exists(os.path.join(ICONS_DIR, 'index.json'))
    tab = any(n.startswith('tabicon_') for n in os.listdir(ICONS_DIR)) if os.path.isdir(ICONS_DIR) else False
    return {'state': icons_job['state'], 'log': icons_job['log'][-12:], 'have': have, 'tabIcons': tab}


def start_icons_job(tab_only=False):
    """Extract item art in the background, reusing the host's game connection."""
    if icons_job['state'] == 'running':
        return
    icons_job.update(state='running', log=[])
    ilog = log_setup.get('icons')

    def log(*a, **k):
        msg = ' '.join(str(x) for x in a)
        icons_job['log'].append(msg)
        ilog.info(msg)

    def work():
        try:
            sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tools'))
            import extract_icons  # needs UnityPy (installed by setup.bat)
            ensure_attached()
            load_gamedata()
            if not tab_only:
                extract_icons.run(client=client, log=log)
            extract_icons.extract_tab_icons(log=log)
            icons_job['state'] = 'done'
        except Exception as e:
            log(f'[!] {e}')
            ilog.exception('icon extraction failed')
            icons_job['state'] = 'failed'
    threading.Thread(target=work, daemon=True).start()


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
    if os.path.exists(os.path.join(ICONS_DIR, 'index.json')) and icons_job['state'] != 'running':
        start_icons_job(tab_only=True)  # item art exists, tab icons were missing until now
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
        # access log -> file only (DEBUG); polling endpoints would flood the console
        if not self.path.startswith(('/api/snapshot', '/api/state', '/api/job', '/icons/')):
            log.debug('%s %s', self.client_address[0], fmt % args)

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

    # ---- access control: this PC is trusted, other devices need the key (cookie)
    def _authorized(self):
        if self.client_address[0] in LOOPBACK:
            return True
        cookie = SimpleCookie(self.headers.get('Cookie', ''))
        return bool(LAN_KEY) and 'sm_key' in cookie and secrets.compare_digest(cookie['sm_key'].value, LAN_KEY)

    def _deny(self):
        body = (b'<h3>StashManager: access key required</h3><p>Open the link shown in the run.bat window '
                b'(it ends with ?key=...) once on this device.</p>')
        self.send_response(403)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _diagnostics(self):
        """Plain-text report for bug reports: environment, connection state, recent log (redacted)."""
        try:
            st = client.state() if client.attached else {'attached': False}
        except Exception as e:
            st = {'error': str(e)}
        parts = ['# StashManager diagnostics', '', '## Environment',
                 json.dumps(log_setup.environment(), indent=1), '', '## Game connection',
                 log_setup.redact(json.dumps(st, indent=1)), '',
                 f'## Server: bound to {HOST}:{PORT}, LAN mode: {bool(LAN_KEY)}', '',
                 '## Recent log (data/logs/stashmanager.log)', log_setup.tail(400)]
        body = '\n'.join(parts).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        if 'key' in q and LAN_KEY and secrets.compare_digest(q['key'][0], LAN_KEY):
            self.send_response(302)  # remember the key in this browser, drop it from the URL
            self.send_header('Set-Cookie', f'sm_key={LAN_KEY}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000')
            self.send_header('Location', '/')
            self.end_headers()
            return
        if not self._authorized():
            return self._deny()
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
                q = parse_qs(urlparse(self.path).query)
                return self._json(200, prices.load(q.get('cycle', [None])[0]))
            except Exception as e:
                return self._json(503, {'ok': False, 'error': str(e)})
        if self.path.startswith('/api/diagnostics'):
            return self._diagnostics()
        if self.path.startswith('/api/icons-status'):
            return self._json(200, icons_status())
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
            log.warning('GET %s failed: %s', self.path.split('?')[0], e)
            client.detach()
            return self._json(503, {'error': str(e)})

    def do_POST(self):
        if self.path not in ('/api/op', '/api/preset-save', '/api/preset-delete', '/api/rules-save',
                             '/api/job-start', '/api/job-cancel', '/api/icons-extract'):
            return self._json(404, {'error': 'unknown endpoint'})
        if not self._authorized():
            return self._json(403, {'error': 'access key required'})
        # reject cross-site requests: the page must be served by this host (same origin)
        origin = self.headers.get('Origin')
        if origin and origin != f"http://{self.headers.get('Host', '')}":
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
            if self.path == '/api/icons-extract':
                start_icons_job()
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
                log.info('auto-sort job requested: %d moves', len(moves))
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
            log.info('op %s %s', op, str(args)[:300])
            return self._json(200, {'ok': True, 'value': client.run(op, args)})
        except Exception as e:
            log.exception('POST %s failed', self.path)
            return self._json(500, {'error': str(e)})


def lan_addresses():
    """Primary address first (the one used for the default route), then other adapters (VMs, WSL...)."""
    primary = None
    try:  # no packet is sent for a UDP connect
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sk:
            sk.connect(('192.0.2.1', 9))
            primary = sk.getsockname()[0]
    except OSError:
        pass
    others = set()
    try:
        others.update(a[4][0] for a in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET))
    except OSError:
        pass
    others = sorted(ip for ip in others if not ip.startswith('127.') and ip != primary)
    return ([primary] if primary else []) + others


def load_lan_key(new=False):
    if not new and os.path.exists(LAN_KEY_PATH):
        with open(LAN_KEY_PATH, encoding='utf-8') as fh:
            key = fh.read().strip()
        if key:
            return key
    key = secrets.token_urlsafe(18)
    os.makedirs(os.path.dirname(LAN_KEY_PATH), exist_ok=True)
    with open(LAN_KEY_PATH, 'w', encoding='utf-8') as fh:
        fh.write(key)
    return key


def main():
    global HOST, PORT, LAN_KEY
    ap = argparse.ArgumentParser(description='StashManager web host')
    ap.add_argument('--host', default='127.0.0.1', help='address to bind (default: this PC only)')
    ap.add_argument('--port', type=int, default=8100)
    ap.add_argument('--lan', action='store_true', help='bind all interfaces: reachable from your network (key required)')
    ap.add_argument('--new-key', action='store_true', help='generate a new access key (old links stop working)')
    a = ap.parse_args()
    HOST, PORT = ('0.0.0.0' if a.lan else a.host), a.port
    exposed = HOST not in ('127.0.0.1', 'localhost', '::1')
    if exposed:
        LAN_KEY = load_lan_key(a.new_key)
        log_setup.add_secret(LAN_KEY)
    log_setup.setup()
    log.info('StashManager starting: %s', json.dumps(log_setup.environment()))
    log.info('binding %s:%s (LAN mode: %s)', HOST, PORT, exposed)

    try:
        ensure_attached()
        log.info('[+] attached to Last Epoch')
    except Exception as e:
        log.info('[!] not attached yet (%s); will retry on first request', e)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f'[+] this PC:  http://127.0.0.1:{PORT}' if HOST in ('0.0.0.0', '127.0.0.1') else f'[+] http://{HOST}:{PORT}')
    if exposed:
        ips = lan_addresses() if HOST == '0.0.0.0' else [HOST]
        print('[+] other devices in your network (open once, then the key is remembered):')
        for i, ip in enumerate(ips):
            print(f'      http://{ip}:{PORT}/?key={LAN_KEY}' + ('   <- main network' if i == 0 and HOST == '0.0.0.0' else ''))
        print('[!] Anyone with this link can move items and spend gold. Keep it private.')
        print('    Windows may ask to allow Python through the firewall: allow "Private networks" only.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        client.detach()


if __name__ == '__main__':
    main()
