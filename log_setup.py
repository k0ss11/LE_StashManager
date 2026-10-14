"""
Logging for StashManager: rotating file data/logs/stashmanager.log (+ console), with redaction of the
LAN access key and the Windows user name, and an environment report for support requests.
"""
import json
import logging
import os
import platform
import re
import subprocess
import sys
from logging.handlers import RotatingFileHandler

ROOT = os.path.dirname(os.path.abspath(__file__))
LOG_DIR = os.path.join(ROOT, 'data', 'logs')
LOG_FILE = os.path.join(LOG_DIR, 'stashmanager.log')
VERSION_FILE = os.path.join(ROOT, 'VERSION')

_secrets = set()
_home = os.path.expanduser('~')


def add_secret(value):
    """Never write this value to the log (e.g. the LAN access key)."""
    if value:
        _secrets.add(value)


def redact(text):
    text = str(text)
    for s in _secrets:
        text = text.replace(s, '<redacted>')
    if _home and len(_home) > 3:  # C:\Users\<name> -> %USERPROFILE%
        text = re.sub(re.escape(_home), '%USERPROFILE%', text, flags=re.I)
        text = re.sub(re.escape(_home.replace('\\', '/')), '%USERPROFILE%', text, flags=re.I)
    return text


class _RedactFilter(logging.Filter):
    def filter(self, record):
        record.msg = redact(record.getMessage())
        record.args = ()
        if record.exc_info and record.exc_info[1] is not None:
            record.exc_text = redact(logging.Formatter().formatException(record.exc_info))
            record.exc_info = None
        return True


_configured = False


def setup(console_level=logging.INFO):
    """Configure the 'sm' logger once. Returns it."""
    global _configured
    log = logging.getLogger('sm')
    if _configured:
        return log
    os.makedirs(LOG_DIR, exist_ok=True)
    log.setLevel(logging.DEBUG)
    fh = RotatingFileHandler(LOG_FILE, maxBytes=2_000_000, backupCount=5, encoding='utf-8')
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(logging.Formatter('%(asctime)s %(levelname)-7s %(name)s: %(message)s'))
    fh.addFilter(_RedactFilter())
    ch = logging.StreamHandler(sys.stdout)
    ch.setLevel(console_level)
    ch.setFormatter(logging.Formatter('%(message)s'))
    ch.addFilter(_RedactFilter())
    log.addHandler(fh)
    log.addHandler(ch)
    log.propagate = False
    _configured = True
    return log


def get(name):
    return logging.getLogger('sm.' + name)


def _pkg_version(mod):
    try:
        return __import__(mod).__version__
    except Exception:
        return 'not installed'


def version():
    v = open(VERSION_FILE, encoding='utf-8').read().strip() if os.path.exists(VERSION_FILE) else 'unknown'
    try:
        sha = subprocess.run(['git', '-C', ROOT, 'rev-parse', '--short', 'HEAD'], capture_output=True,
                             text=True, timeout=3).stdout.strip()
        dirty = subprocess.run(['git', '-C', ROOT, 'status', '--porcelain'], capture_output=True,
                               text=True, timeout=3).stdout.strip()
        if sha:
            v += f' ({sha}{", modified" if dirty else ""})'
    except Exception:
        pass
    return v


def environment():
    """Facts that matter for support. No account data, no stash contents."""
    env = {
        'stashmanager': version(),
        'python': sys.version.split()[0],
        'os': f'{platform.system()} {platform.release()} ({platform.version()})',
        'frida': _pkg_version('frida'),
        'UnityPy': _pkg_version('UnityPy'),
    }
    cfg_path = os.path.join(ROOT, 'config.json')
    if os.path.exists(cfg_path):
        with open(cfg_path, encoding='utf-8-sig') as fh:
            cfg = json.load(fh)
        env['gamePath'] = cfg.get('gamePath')
        build = None
        hash_file = os.path.join(cfg.get('gamePath', ''), 'Last Epoch_Data', 'build_hash.txt')
        if os.path.exists(hash_file):
            build = open(hash_file, encoding='utf-8').read().strip()
        env['gameBuild'] = build
        try:
            with open(os.path.join(ROOT, 'supported_builds.json'), encoding='utf-8') as fh:
                env['gameBuildTested'] = any(b['buildHash'] == build for b in json.load(fh)['builds'])
        except Exception:
            pass
    else:
        env['config'] = 'missing (run setup.bat)'
    return {k: redact(v) for k, v in env.items()}


def tail(lines=300):
    if not os.path.exists(LOG_FILE):
        return ''
    with open(LOG_FILE, encoding='utf-8', errors='replace') as fh:
        return ''.join(fh.readlines()[-lines:])
