"""
Full stash CRUD confirmation including ONE tab purchase (costs gold, tab is permanent).

  tab:    buy -> rename -> color -> icon -> reorder in folder -> move to other folder -> back
  folder: create -> rename -> color -> icon -> reorder -> host a tab -> delete
  item:   move into the new tab and back

Run with the stash open:  python tools/dev/crud_full_test.py --buy [--max-cost 30000]

WARNING: --buy SPENDS GOLD and the bought tab can never be deleted. Without --buy it tests on an
existing empty tab and spends nothing.
The bought tab is left in the first folder as "SM_TEST" (rename it in game as you like).
"""
import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from game_client import GameClient  # noqa: E402

results = []


def step(name, ok, detail=''):
    results.append((name, bool(ok)))
    print(f'[{"PASS" if ok else "FAIL"}] {name} {detail}')
    return ok


def tab(s, tab_id):
    return next((t for t in s['tabs'] if t['id'] == tab_id), None)


def cat(s, cat_id):
    return next((c for c in s['categories'] if c['id'] == cat_id), None)


def tabs_in(s, cat_id):
    return sorted((t for t in s['tabs'] if t['categoryId'] == cat_id), key=lambda t: t['order'])


def item_at(s, container, x, y):
    return next((i for i in s['containers'][container]['items'] if i['x'] == x and i['y'] == y), None)


def free_spot(container, w, h):
    occ = {(it['x'] + dx, it['y'] + dy) for it in container['items'] for dx in range(it['w']) for dy in range(it['h'])}
    for y in range(container['h'] - h + 1):
        for x in range(container['w'] - w + 1):
            if all((x + dx, y + dy) not in occ for dx in range(w) for dy in range(h)):
                return x, y
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--buy', action='store_true', help='allow buying one tab')
    ap.add_argument('--max-cost', type=int, default=30000)
    a = ap.parse_args()

    c = GameClient()
    c.attach()
    time.sleep(0.5)
    w = c.wait_for  # shorthand

    s0 = c.snapshot()
    if not s0['stashOpen']:
        print('[!] stash is not open - open it in game first')
        return
    first_cat = min(s0['categories'], key=lambda x: x['order'])['id']
    other_cat = next(x['id'] for x in sorted(s0['categories'], key=lambda x: x['order']) if x['id'] != first_cat)
    print(f"gold {s0['gold']}, {len(s0['tabs'])} tabs, {len(s0['categories'])} folders")

    # ------------------------------------------------------------------ buy
    new_id = None
    if a.buy:
        cost = c.run('nextTabCost')
        print(f'next tab cost: {cost}')
        if cost > a.max_cost or cost > (s0['gold'] or 0):
            print(f'[!] refusing: cost {cost} > max {a.max_cost} or gold {s0["gold"]}')
        else:
            known = {t['id'] for t in s0['tabs']}
            order = len(tabs_in(s0, first_cat))
            c.run('tabPurchase', {'parentId': first_cat, 'order': order, 'name': 'SM_TEST'})
            s = w(lambda s: len(s['tabs']) > len(s0['tabs']), timeout=5)
            if step('tab purchase', s is not None):
                new = next(t for t in s['tabs'] if t['id'] not in known)
                new_id = new['id']
                step('  tab in container list', len(s['containers']) > new_id, f'(tab id {new_id})')
                step('  gold charged', s['gold'] == s0['gold'] - cost, f"{s0['gold']} -> {s['gold']}")
                step('  placed in folder', new['categoryId'] == first_cat, f"name={new['name']!r}")
    if new_id is None:
        # fall back to an empty existing tab so the rest can still be verified
        s = c.snapshot()
        empty = [t for t in s['tabs'] if not s['containers'][t['id']]['items']]
        if not empty:
            print('[!] no tab to test on')
            return c.detach()
        new_id = empty[0]['id']
        print(f'[i] testing on existing empty tab {new_id} ({empty[0]["name"]})')
    orig = dict(tab(c.snapshot(), new_id))

    # ------------------------------------------------------------------ tab configure
    c.run('tabConfigure', {'id': new_id, 'name': 'SM_RENAMED'})
    step('tab rename', w(lambda s: tab(s, new_id)['name'] == 'SM_RENAMED'))
    c.run('tabConfigure', {'id': new_id, 'color': 6})
    step('tab color', w(lambda s: tab(s, new_id)['color'] == 6))
    c.run('tabConfigure', {'id': new_id, 'icon': 3})
    step('tab icon', w(lambda s: tab(s, new_id)['icon'] == 3))

    # ------------------------------------------------------------------ tab sequence
    s = c.snapshot()
    home = tab(s, new_id)['categoryId']
    before = [t['id'] for t in tabs_in(s, home)]
    c.run('tabReorder', {'id': new_id, 'order': 0})
    s = w(lambda s: tabs_in(s, home)[0]['id'] == new_id)
    step('tab reorder to first', s, str([t['id'] for t in tabs_in(s, home)]) if s else str(before))
    last = len(before) - 1
    c.run('tabReorder', {'id': new_id, 'order': last})
    s = w(lambda s: [t['id'] for t in tabs_in(s, home)] == before)
    step('tab reorder back', s, str([t['id'] for t in tabs_in(s or c.snapshot(), home)]))

    # ------------------------------------------------------------------ move to other folder
    c.run('tabConfigure', {'id': new_id, 'parentId': other_cat})
    s = w(lambda s: tab(s, new_id)['categoryId'] == other_cat)
    step('tab move to other folder', s, f'(folder {other_cat})')
    c.run('tabConfigure', {'id': new_id, 'parentId': home})
    step('tab move back', w(lambda s: tab(s, new_id)['categoryId'] == home))

    # ------------------------------------------------------------------ folder CRUD + sequence
    known_cats = {x['id'] for x in c.snapshot()['categories']}
    c.run('categoryCreate', {'name': 'SM_FOLDER'})
    s = w(lambda s: any(x['name'] == 'SM_FOLDER' for x in s['categories']))
    if step('folder create', s):
        fid = next(x['id'] for x in s['categories'] if x['id'] not in known_cats)
        c.run('categoryConfigure', {'id': fid, 'name': 'SM_FOLDER_R'})
        step('folder rename', w(lambda s: cat(s, fid)['name'] == 'SM_FOLDER_R'))
        c.run('categoryConfigure', {'id': fid, 'color': 4})
        step('folder color', w(lambda s: cat(s, fid)['color'] == 4))
        c.run('categoryConfigure', {'id': fid, 'icon': 5})
        step('folder icon', w(lambda s: cat(s, fid)['icon'] == 5))

        cats_before = [x['id'] for x in sorted(c.snapshot()['categories'], key=lambda x: x['order'])]
        c.run('categoryReorder', {'id': fid, 'order': 0})
        s = w(lambda s: min(s['categories'], key=lambda x: x['order'])['id'] == fid)
        step('folder reorder to first', s)
        c.run('categoryReorder', {'id': fid, 'order': len(cats_before) - 1})
        s = w(lambda s: [x['id'] for x in sorted(s['categories'], key=lambda x: x['order'])] == cats_before)
        step('folder reorder back', s)

        c.run('tabConfigure', {'id': new_id, 'parentId': fid})
        step('tab into new folder', w(lambda s: tab(s, new_id)['categoryId'] == fid))
        c.run('tabConfigure', {'id': new_id, 'parentId': home})
        step('tab out of new folder', w(lambda s: tab(s, new_id)['categoryId'] == home))

        c.run('categoryDelete', {'id': fid})
        step('folder delete', w(lambda s: cat(s, fid) is None))

    # ------------------------------------------------------------------ item into new tab and back
    s = c.snapshot()
    src_tab = next(ct['index'] for ct in s['containers'] if ct['items'] and ct['index'] != new_id)
    it = s['containers'][src_tab]['items'][0]
    src = (it['x'], it['y'])
    dst = free_spot(s['containers'][new_id], it['w'], it['h'])

    def move(ft, fpos, tt, tpos, label):
        c.run('switchTab', {'tabId': ft})
        w(lambda s: s['activeTab'] == ft)
        c.run('pickup', {'x': fpos[0], 'y': fpos[1]})
        s1 = w(lambda s: s['cursorItem'] is not None)
        if not step(f'{label}: pickup', s1):
            return None
        mid = s1['cursorItem']['id']
        try:
            c.run('switchTab', {'tabId': tt})
            w(lambda s: s['activeTab'] == tt)
            c.run('drop', {'x': tpos[0], 'y': tpos[1]})
            return step(f'{label}: drop', w(lambda s: s['cursorItem'] is None and
                                            (item_at(s, tt, *tpos) or {}).get('id') == mid), f'tab {tt} {tpos}')
        finally:
            if c.snapshot(False)['cursorItem'] is not None:
                print('    cursor not empty -> returnCursor')
                c.run('returnCursor')
                w(lambda s: s['cursorItem'] is None)

    if move(src_tab, src, new_id, dst, 'item -> new tab'):
        move(new_id, dst, src_tab, src, 'item back')

    # ------------------------------------------------------------------ final state
    final_name = 'SM_TEST' if a.buy else orig['name']
    c.run('tabConfigure', {'id': new_id, 'name': final_name, 'color': orig['color'], 'icon': orig['icon']})
    s = w(lambda s: tab(s, new_id)['name'] == final_name)
    c.run('switchTab', {'tabId': s0['activeTab']})
    s = c.snapshot()
    counts0 = [len(x['items']) for x in s0['containers']]
    counts = [len(x['items']) for x in s['containers']][:len(counts0)]
    step('item counts unchanged', counts == counts0, str(counts))
    step('cursor empty', s['cursorItem'] is None)
    print(f"\n{sum(ok for _, ok in results)}/{len(results)} passed; gold {s0['gold']} -> {s['gold']}")
    c.detach()


if __name__ == '__main__':
    main()
