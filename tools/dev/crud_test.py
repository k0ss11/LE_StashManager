"""
Live CRUD confirmation against the open stash. Every step is verified by re-reading game
memory (server round trip) and reverted afterwards. Never buys tabs.

Run with the stash open:  python tools/dev/crud_test.py   (spends no gold)
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from game_client import GameClient  # noqa: E402

STASH, INVENTORY = 21, 1
results = []


def step(name, ok, detail=''):
    results.append((name, ok))
    print(f'[{"PASS" if ok else "FAIL"}] {name} {detail}')
    return ok


def cat_by_name(s, name):
    return next((c for c in s['categories'] if c['name'] == name), None)


def tab_by_id(s, tab_id):
    return next((t for t in s['tabs'] if t['id'] == tab_id), None)


def item_at(s, container, x, y):
    return next((i for i in s['containers'][container]['items'] if i['x'] == x and i['y'] == y), None)


def free_spot(container, w, h):
    occ = set()
    for it in container['items']:
        for dx in range(it['w']):
            for dy in range(it['h']):
                occ.add((it['x'] + dx, it['y'] + dy))
    for y in range(container['h'] - h + 1):
        for x in range(container['w'] - w + 1):
            if all((x + dx, y + dy) not in occ for dx in range(w) for dy in range(h)):
                return x, y
    return None


def main():
    c = GameClient()
    c.attach()
    time.sleep(0.5)
    st = c.state()
    if not st['stashOpen']:
        print('[!] stash is not open - open it in game first')
        return
    s0 = c.snapshot()
    print(f"stash {s0['stashIndex']}: {len(s0['tabs'])} tabs, {len(s0['categories'])} folders, active tab {s0['activeTab']}")

    # ---- folder: create / rename / delete
    c.run('categoryCreate', {'name': 'SM_TEST'})
    s = c.wait_for(lambda s: cat_by_name(s, 'SM_TEST'))
    if step('folder create', s is not None):
        cat = cat_by_name(s, 'SM_TEST')
        c.run('categoryConfigure', {'id': cat['id'], 'name': 'SM_TEST_RENAMED', 'color': 3})
        s = c.wait_for(lambda s: cat_by_name(s, 'SM_TEST_RENAMED'))
        step('folder rename+color', s is not None and cat_by_name(s, 'SM_TEST_RENAMED')['color'] == 3)

        # ---- tab: rename / recolor / move into folder, then restore
        tab = max(s0['tabs'], key=lambda t: t['id'])
        orig = dict(tab)
        c.run('tabConfigure', {'id': tab['id'], 'name': 'SM_TAB', 'color': 5})
        s = c.wait_for(lambda s: tab_by_id(s, tab['id'])['name'] == 'SM_TAB')
        step('tab rename+color', s is not None and tab_by_id(s, tab['id'])['color'] == 5, f"(tab {tab['id']})")

        c.run('tabUpdateParent', {'id': tab['id'], 'parentId': cat['id']})
        s = c.wait_for(lambda s: tab_by_id(s, tab['id'])['categoryId'] == cat['id'])
        step('tab move to folder (UpdateParent)', s is not None)
        if s is None:
            c.run('tabConfigure', {'id': tab['id'], 'parentId': cat['id']})
            s = c.wait_for(lambda s: tab_by_id(s, tab['id'])['categoryId'] == cat['id'])
            step('tab move to folder (Configure)', s is not None)

        c.run('tabUpdateParent', {'id': tab['id'], 'parentId': orig['categoryId']})
        c.run('tabConfigure', {'id': tab['id'], 'name': orig['name'], 'color': orig['color'],
                               'parentId': orig['categoryId']})
        s = c.wait_for(lambda s: (lambda t: t['name'] == orig['name'] and t['categoryId'] == orig['categoryId']
                                  and t['color'] == orig['color'])(tab_by_id(s, tab['id'])))
        step('tab restore', s is not None)

        c.run('categoryDelete', {'id': cat['id']})
        s = c.wait_for(lambda s: cat_by_name(s, 'SM_TEST_RENAMED') is None)
        step('folder delete', s is not None)

    # ---- item moves via cursor: within a tab, then across tabs; always restored
    s = c.snapshot()
    # emptiest tab with items = has room; source for cross-tab = any other tab with items
    roomy = sorted((ct for ct in s['containers'] if ct['items']), key=lambda ct: len(ct['items']))
    tab_index = roomy[0]['index']
    tab_id = tab_index  # containers are indexed by tab id (verified via activeTab)

    def move(from_tab, src, to_tab, dst, label):
        """pickup at src in from_tab -> drop at dst in to_tab; verify by item id."""
        if s_now()['activeTab'] != from_tab:
            c.run('switchTab', {'tabId': from_tab})
            c.wait_for(lambda s: s['activeTab'] == from_tab)
        c.run('pickup', {'x': src[0], 'y': src[1]})
        s1 = c.wait_for(lambda s: s['cursorItem'] is not None)
        if not step(f'{label}: pickup', s1 is not None, f'tab {from_tab} {src}'):
            return None
        moving_id = s1['cursorItem']['id']
        try:
            if from_tab != to_tab:
                c.run('switchTab', {'tabId': to_tab})
                c.wait_for(lambda s: s['activeTab'] == to_tab)
            c.run('drop', {'x': dst[0], 'y': dst[1]})
            s2 = c.wait_for(lambda s: s['cursorItem'] is None and
                            (lambda it: it is not None and it['id'] == moving_id)(item_at(s, to_tab, *dst)))
            step(f'{label}: drop', s2 is not None, f'tab {to_tab} {dst}')
            return s2
        finally:
            if c.snapshot(False)['cursorItem'] is not None:
                print('    cursor not empty -> returnCursor')
                c.run('returnCursor')
                c.wait_for(lambda s: s['cursorItem'] is None)

    s_now = lambda: c.snapshot()  # noqa: E731

    c.run('switchTab', {'tabId': tab_id})
    s = c.wait_for(lambda s: s['activeTab'] == tab_id)
    step('switch tab', s is not None, f'(tab {tab_id})')

    item = s['containers'][tab_index]['items'][0]
    src = (item['x'], item['y'])
    dst = free_spot(s['containers'][tab_index], item['w'], item['h'])
    if move(tab_id, src, tab_id, dst, 'within tab'):
        move(tab_id, dst, tab_id, src, 'within tab back')

    s = c.snapshot()
    other = next(ct for ct in s['containers'] if ct['items'] and ct['index'] != tab_index)
    item = other['items'][0]
    src = (item['x'], item['y'])
    dst = free_spot(s['containers'][tab_index], item['w'], item['h'])
    if dst and move(other['index'], src, tab_index, dst, 'cross tab'):
        move(tab_index, dst, other['index'], src, 'cross tab back')
    s = c.snapshot()

    # ---- item: quick move stash -> inventory -> stash (acts on the active tab)
    c.run('switchTab', {'tabId': tab_id})
    s = c.wait_for(lambda s: s['activeTab'] == tab_id)
    inv_before = len(s['inventory'])
    stash_before = len(s['containers'][tab_index]['items'])
    item = s['containers'][tab_index]['items'][0]
    c.run('quickMove', {'src': STASH, 'dst': INVENTORY, 'x': item['x'], 'y': item['y']})
    s = c.wait_for(lambda s: len(s['inventory']) == inv_before + 1)
    if step('quick move stash->inventory', s is not None):
        moved = next(i for i in s['inventory'] if i['id'] == item['id'])
        c.run('quickMove', {'src': INVENTORY, 'dst': STASH, 'x': moved['x'], 'y': moved['y']})
        s = c.wait_for(lambda s: len(s['inventory']) == inv_before)
        step('quick move inventory->stash', s is not None,
             f"(landed in tab {next((ct['index'] for ct in s['containers'] if any(i['id'] == item['id'] for i in ct['items'])), '?')})"
             if s else '')
        if s:
            step('stash count restored', len(s['containers'][tab_index]['items']) == stash_before)

    c.run('switchTab', {'tabId': s0['activeTab']})
    print(f"\n{sum(ok for _, ok in results)}/{len(results)} passed")
    c.detach()


if __name__ == '__main__':
    main()
