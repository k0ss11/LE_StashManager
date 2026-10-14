"""
Market prices from the Last Epoch Overlay public API (https://www.leoverlay.com/developers).
Community-observed asking prices (not sales). Free to use with attribution.

Polls at most hourly per feed, uses ETag / If-None-Match, caches to data/prices/.
IDs match the game: uniqueId, affixId, tier (zero-based), itemType (= base type id).
"""
import json
import os
import threading
import time
import urllib.request

import log_setup

log = log_setup.get('prices')

BASE = 'https://bazaar.leoverlay.com'
CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'prices')
REFRESH_SECONDS = 3600
UA = 'StashManager (local tool; https://www.leoverlay.com/developers attribution shown)'

_lock = threading.Lock()


def _get(path, etag=None):
    req = urllib.request.Request(BASE + path, headers={'User-Agent': UA, 'Accept': 'application/json'})
    if etag:
        req.add_header('If-None-Match', etag)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.headers.get('ETag'), json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return 304, etag, None
        raise


def _cached(name):
    path = os.path.join(CACHE_DIR, name + '.json')
    if os.path.exists(path):
        with open(path, encoding='utf-8') as fh:
            return json.load(fh)
    return None


def _store(name, entry):
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(os.path.join(CACHE_DIR, name + '.json'), 'w', encoding='utf-8') as fh:
        json.dump(entry, fh)


def _feed(name, path):
    """Return cached body, refreshing from the API when older than REFRESH_SECONDS."""
    entry = _cached(name)
    if entry and time.time() - entry['fetchedAt'] < REFRESH_SECONDS:
        return entry
    try:
        status, etag, body = _get(path, entry and entry.get('etag'))
        if status == 304 and entry:
            entry['fetchedAt'] = time.time()  # body unchanged; quote expiry still checked per quote
        else:
            entry = {'fetchedAt': time.time(), 'etag': etag, 'body': body}
        _store(name, entry)
        log.info('price feed %s refreshed (HTTP %s)', name, status)
    except Exception as e:  # keep serving the old cache on network errors / 429
        log.warning('price feed %s refresh failed: %s (using cache: %s)', name, e, bool(entry))
        if not entry:
            raise RuntimeError(f'price feed {name} unavailable: {e}')
    return entry


_idol_refresh = {}  # cycle -> thread


def _idols_refresh(cycle):
    """Fetch all idol pages (paced 3 s apart per API docs), dedupe by id, cache."""
    try:
        quotes, page, total = {}, 0, None
        while total is None or page * 50 < total:
            status, _, body = _get(f'/v1/pricing/idols?cycle={cycle}&page={page}')
            total = body.get('total', 0)
            for q in body.get('quotes', []):
                quotes[q['id']] = q
            page += 1
            time.sleep(3)
        _store(f'idols_{cycle}', {'fetchedAt': time.time(), 'body': {'quotes': list(quotes.values()), 'total': total}})
        log.info('idol prices refreshed: %d combinations', len(quotes))
    except Exception as e:
        log.warning('idol price refresh failed: %s (keeping previous cache)', e)
    finally:
        _idol_refresh.pop(cycle, None)


def _idols(cycle):
    entry = _cached(f'idols_{cycle}')
    stale = not entry or time.time() - entry['fetchedAt'] > REFRESH_SECONDS
    if stale and cycle not in _idol_refresh:
        t = threading.Thread(target=_idols_refresh, args=(cycle,), daemon=True)
        _idol_refresh[cycle] = t
        t.start()
    return entry


def idol_key(item_type, sub_type, affixes, with_tier=True):
    parts = sorted(f"{a[0]}:{a[1]}" if with_tier else str(a[0]) for a in affixes)
    return f"{item_type}:{sub_type}:" + ','.join(parts)


def cycles():
    return _feed('cycles', '/v1/cycles')['body']


def load(cycle=None, weavers_will=True):
    """Compact price tables for the page."""
    with _lock:
        cyc = cycles()
        cycle = cycle or cyc.get('defaultCycleId') or cyc['cycles'][0]['id']
        uq = _feed(f'uniques_{cycle}', f'/v1/pricing/uniques?cycle={cycle}' + ('&weaversWill=1' if weavers_will else ''))
        af = _feed(f'affixes_{cycle}', f'/v1/pricing/affixes?cycle={cycle}')
    now_ms = time.time() * 1000

    def usable(q):
        return q.get('medianGold') is not None and (q.get('expiresAt') or 0) > now_ms

    uniques = {}
    for q in uq['body'].get('quotes', []):
        i = q['identity']
        if i.get('variantAffixIds') or not usable(q):
            continue  # overall item price per LP only
        uniques[f"{i['uniqueId']}:{i.get('legendaryPotential', 0)}"] = [q['medianGold'], q.get('listingCount'), q.get('status')]
    affixes = {}
    for q in af['body'].get('quotes', []):
        i = q['identity']
        if usable(q):
            affixes[f"{i['itemType']}:{i['affixId']}:{i['tier']}"] = [q['medianGold'], q.get('listingCount'), q.get('status')]
    # idols: exact combination (type, subtype, affix id+tier) and a looser "same affixes, any tier" median
    idols, loose = {}, {}
    ientry = _idols(cycle)
    for q in (ientry or {}).get('body', {}).get('quotes', []):
        if not usable(q):
            continue
        i = q['identity']
        affs = [(a['id'], a['tier']) for a in i.get('affixes', [])]
        k = idol_key(i['itemType'], i['subType'], affs) + (':c' if i.get('corrupted') else '')
        idols[k] = [q['medianGold'], q.get('listingCount'), q.get('status')]
        # same affixes at any tier: keep each combo's tiers so the page only compares against
        # combos that are not better than the item (avoids pricing T1 idols like T4 ones)
        # only well-listed quotes, same corruption state (corrupted idols price very differently)
        if q.get('status') == 'available':
            tiers = {a[0]: a[1] for a in affs}
            lk = idol_key(i['itemType'], i['subType'], affs, with_tier=False) + (':c' if i.get('corrupted') else '')
            loose.setdefault(lk, []).append([tiers, q['medianGold'], q.get('listingCount')])
    return {
        'ok': True, 'cycle': cycle,
        'idols': idols, 'idolsLoose': loose, 'idolsPending': ientry is None, 'cycles': cyc.get('cycles', []),
        'fetchedAt': min(uq['fetchedAt'], af['fetchedAt']),
        'uniques': uniques, 'affixes': affixes,
        'attribution': 'Prices: Last Epoch Overlay (community asking prices)',
        'attributionUrl': 'https://www.leoverlay.com/developers',
    }
