"""
Extract item icons from the game's asset bundles.

1. Agent asks the game which sprite each item uses (ItemData.GetItemSprite) and where it
   lives (LEAssetBundlesCatalog.GetObjectLocation) - no assets are loaded in game.
2. UnityPy reads only those bundles from disk and saves the sprites as PNG.

Needs the game running + data/gamedata.json (start host.py once).
Needs UnityPy (pip install --user UnityPy), so run WITHOUT python -I:
    python tools/extract_icons.py [--size 160]
Output: data/icons/<name>.png + data/icons/index.json {"b<type>_<sub>": file, "u<uniqueId>": file}
Also: stash tab icons (names from data/tabstyles.json) -> data/icons/tabicon_<name>.png (from PermaLoad.bundle)
"""
import argparse
import json
import os
import sys
import time
from collections import defaultdict

import UnityPy

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from game_client import GameClient  # noqa: E402

OUT_DIR = os.path.join(ROOT, 'data', 'icons')


def _game_path():
    cfg = os.path.join(ROOT, 'config.json')  # written by setup.ps1
    if os.path.exists(cfg):
        with open(cfg, encoding='utf-8-sig') as fh:
            return json.load(fh)['gamePath']
    return r'C:\Program Files (x86)\Steam\steamapps\common\Last Epoch'


BUNDLE_DIR = os.path.join(_game_path(), 'Last Epoch_Data', 'StreamingAssets', 'LEAssetBundles')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--size', type=int, default=160, help='max icon edge in px')
    ap.add_argument('--bundles', default=BUNDLE_DIR)
    a = ap.parse_args()

    with open(os.path.join(ROOT, 'data', 'gamedata.json'), encoding='utf-8') as fh:
        gd = json.load(fh)
    reqs = []
    for b in gd['bases']:
        for s in b['subs']:
            reqs.append(('b%d_%d' % (b['id'], s['id']), {'type': b['id'], 'sub': s['id']}))
    for u in gd['uniques']:
        reqs.append(('u%d' % u['id'], {'type': u['baseType'], 'sub': 0, 'unique': True, 'uniqueId': u['id']}))
    print(f'[*] resolving {len(reqs)} icons in game')

    c = GameClient()
    c.attach()
    time.sleep(0.4)
    refs = {}
    for i in range(0, len(reqs), 100):  # small batches: each batch runs in one game frame
        chunk = reqs[i:i + 100]
        res = c.run('iconRefs', {'reqs': [r for _, r in chunk]}, delay_ms=50, timeout=20)
        for (key, _), ref in zip(chunk, res):
            if ref and not ref.get('error') and ref.get('file'):
                refs[key] = ref
    c.detach()
    print(f'[+] resolved {len(refs)}/{len(reqs)}')

    by_bundle = defaultdict(list)
    for key, ref in refs.items():
        by_bundle[ref['file']].append((key, ref))

    os.makedirs(OUT_DIR, exist_ok=True)
    index, saved, failed = {}, {}, 0
    for n, (bundle, items) in enumerate(sorted(by_bundle.items()), 1):
        try:
            env = UnityPy.load(os.path.join(a.bundles, bundle))
            sprites = {}
            for obj in env.objects:
                if obj.type.name == 'Sprite':
                    sp = obj.read()
                    sprites[sp.m_Name] = sp
            for key, ref in items:
                fname = ref['subPath'] or bundle.replace('.bundle', '')
                fname = ''.join(ch if ch.isalnum() or ch in '_-' else '_' for ch in fname) + '.png'
                if fname not in saved:
                    sp = sprites.get(ref['subPath']) or (next(iter(sprites.values())) if len(sprites) == 1 else None)
                    if sp is None:
                        failed += 1
                        continue
                    img = sp.image
                    img.thumbnail((a.size, a.size))
                    img.save(os.path.join(OUT_DIR, fname), optimize=True)
                    saved[fname] = True
                index[key] = fname
        except Exception as e:  # corrupt / unsupported bundle - skip
            failed += len(items)
            print(f'\n[!] {bundle}: {e}')
        if n % 200 == 0 or n == len(by_bundle):
            print(f'[*] bundles {n}/{len(by_bundle)}', flush=True)

    with open(os.path.join(OUT_DIR, 'index.json'), 'w', encoding='utf-8') as fh:
        json.dump({'build': gd.get('build'), 'icons': index}, fh)
    print(f'\n[+] {len(saved)} images, {len(index)} items mapped, {failed} failed -> {OUT_DIR}')


def extract_tab_icons(bundle_dir):
    path = os.path.join(ROOT, 'data', 'tabstyles.json')
    if not os.path.exists(path):
        print('[i] no data/tabstyles.json yet (open the stash with host.py running) - skipping tab icons')
        return
    with open(path, encoding='utf-8') as fh:
        names = {n for n in json.load(fh).get('icons', []) if n}
    env = UnityPy.load(os.path.join(bundle_dir, 'PermaLoad.bundle'))
    done = set()
    for obj in env.objects:
        if obj.type.name != 'Sprite':
            continue
        try:
            sp = obj.read()
        except Exception:
            continue
        if sp.m_Name in names and sp.m_Name not in done:
            img = sp.image
            img.thumbnail((64, 64))
            img.save(os.path.join(OUT_DIR, 'tabicon_' + sp.m_Name + '.png'))
            done.add(sp.m_Name)
    print(f'[+] tab icons: {len(done)}/{len(names)}')


if __name__ == '__main__':
    main()
    extract_tab_icons(BUNDLE_DIR)
