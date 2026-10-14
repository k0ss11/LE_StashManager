# Development notes

How LE StashManager works inside the game, what was verified, and how to keep it working after a
patch. For using the tool see [USAGE.md](USAGE.md).

Verified against Last Epoch Season 5 (Unity 6, IL2CPP metadata v39). Tested builds are listed in
[`supported_builds.json`](../supported_builds.json).

## Architecture

```
browser (127.0.0.1:8100) <-> host.py (Python http.server) <-> game_client.py <-> agent/agent.js (Frida, in game)
                                  |-> mover.py   (background move jobs)
                                  |-> prices.py  (Last Epoch Overlay price feed, hourly, cached)
```

| File | Role |
|---|---|
| `agent/agent.js` | Runs inside the game (Frida). Reads memory, queues write actions on the main thread. |
| `game_client.py` | Attaches Frida, loads the agent, RPC helpers (`run`, `run_batch`, `wait_for`). |
| `host.py` | Local web server (127.0.0.1 only, origin check on POST), JSON API, static files. |
| `mover.py` | Executes planned item moves in batches, verifying each one. |
| `prices.py` | Market price feed client (ETag, hourly, rate-limit friendly). |
| `web/index.html` | Main page: grid, search, tooltip, item enrichment (names, values, exalted). |
| `web/configure.js` | Tab / folder dialogs, priority editor, `priorityMatches` (JS port of the game rule). |
| `web/presets.js` | Presets: capture, import/export, planner (reuse first), executor. |
| `web/sort.js` | Auto-sort planner, rules, space forecast, job UI. |
| `web/prices.js` | Item / tab / stash value, price filter. |
| `tools/apply_preset.js` | Same preset planner from the command line (`--dry`, `--wait-open`). |
| `tools/extract_icons.py` | Item + tab icons from local asset bundles (UnityPy). |
| `tools/il2cpp_dump.py` | Live class/field/method dump of the running game (Il2CppDumper can't read v39). |
| `tools/dev/*` | Live CRUD checks (`crud_full_test.py --buy` spends gold) and a class inspector. |

### Agent rules

- **Reads** are plain memory reads, safe from the Frida thread.
- **Writes** (anything calling game code) are queued and executed one per frame inside a hook on
  `LE.CustomUpdate.UpdateSystem.Update` (main thread), via `il2cpp_runtime_invoke` so managed
  exceptions come back as errors instead of crashing. Never call managed code from the Frida thread.
- Classes, fields and methods are resolved **by name** at runtime (`cls`, `off`, `method`,
  `methodExact` for overloads), so offsets in this file are informational.

## Stash data model (client memory)

The client holds a full copy of the stash, even with the stash closed.

```
ItemContainersManager._instance
  .stash -> StashHolderItemContainer
      .stashItemContainers -> StashItemContainer[]      one per stash (softcore / hardcore / solo...)
      .<CurrentStashIndex>k__BackingField
  StashItemContainer : TabbedItemContainer
      .currentlyActiveTab                               container index == tab id
      .containers -> List<ItemContainer>                one per tab, 12x17 grid
  ItemContainer.content -> List<ItemContainerEntry>
  ItemContainerEntry: data (ItemData), <Position> (Vector2Int, origin BOTTOM-left), size, quantity
  ItemData: itemType (base type id), subType, rarity, uniqueID, corrupted, forgingPotential,
            legendaryPotential, weaversWill, implicitRolls, uniqueRolls, affixes -> List<ItemAffix>
  ItemAffix: affixId, affixTier (0-based), affixRoll (0-255), affixName, sealedAffixType
  cursor: OneSlotItemContainer, single entry (not a list)

LocalPlayer.instance
  .stashInfo -> ClientStashInfo: categories (folders), tabs (name, icon, colour, order, _tabPriority)
  .goldTracker.value                                    gold (ItemContainersManager.goldTracker is server-side)
UIBase.instance.IsStashOpen()                           stash panel open == player at stash
```

Rarity byte: 0 normal, 1-2 magic, 3-4 rare, 7 unique, 8 set, 9 legendary. "Exalted" is not a
rarity: magic/rare with any T6+ affix (`ItemData.isExaltedItem`).

## Actions (all verified live)

The server is authoritative; the agent sends the same requests as the stash UI
(`PlayerSync.local.Send*`).

| Action | Call | Notes |
|---|---|---|
| switch tab | `TabbedItemContainer.TrySwitchToTab(i, true)` | `SendTrySwitchToTab` alone does nothing client-side |
| pick up / drop | `SendPickupItemToCursor`, `SendTryDropItemFromCursor` | works with STASH (21) and INVENTORY (1) |
| shift-click | `SendTryManualQuickMove(src, dst, pos)` | stash -> inventory; inventory -> stash is **routed by tab priority** |
| buy tab | `SendStashTabPurchase` | cost: `StashHelpers.NextTabCost(tabCount)`; tabs cannot be deleted |
| configure tab | `SendStashTabConfigure` | name, icon, colour, folder (`parentId`), priority |
| reorder tab / folder | `SendStashTabReorder`, `SendStashCategoryReorder` | |
| folder create / configure / delete | `SendStashCategoryCreate / Configure / Delete` | folders have **no** priority |
| move tab to folder | use `SendStashTabConfigure(parentId)` | `SendStashTabUpdateParent` has no effect |

Checks: `tools/dev/crud_test.py` (no gold, everything reverted) and
`tools/dev/crud_full_test.py --buy` (26 checks incl. one tab purchase).

## Tab priority (auto-stash rules)

`StashPriority` = 8 optional conditions (potential, rarity, type, class, level, faction, uniques,
corruption). The in-game "Tab Priority" checkbox is just `HasValue()`; an empty priority is stored
as null.

- Read from memory (`readPriority`; HashSet `_slots` = {hash, next, value}, stride 12).
- Built on the main thread (`buildPriority`: `object_new` + `.ctor` + field writes + the
  collections' own `Add`), passed to `SendStashTabConfigure`.
- The game checks priority tabs **left to right** (folder order, then tab order); first match wins.

```js
spec = {
  rarity: /* flags */ NORMAL 1 | MAGIC 2 | RARE 4 | UNIQUE 8 | SET 16 | LEGENDARY 32 | EXALTED 64,
  type: { types: [baseTypeId], subTypes: [] },
  potential: { MinLegendaryPotential, MaxLegendaryPotential, MinWeaversWill, MaxWeaversWill,
               MinWeaversTouch, MaxWeaversTouch, MinForgingPotential, MaxForgingPotential },
  classReq: /* flags */ Primalist 1 | Mage 2 | Sentinel 4 | Acolyte 8 | Rogue 16,
  level: { min, max }, faction: [FactionID], uniques: [uniqueId],
  corruption: 0 /* any */ | 1 /* only corrupted */ | 2 /* only uncorrupted */,
}
```

## Presets

`presets/*.json` (built-in) and `data/presets/*.json` (user, incl. automatic backups).

Planner (`planPreset`): folders by name -> reuse other folders -> create. Tabs by name ->
content-aware reuse (existing tab already holding most items the preset tab's rule matches) ->
emptiest spare tab -> buy. Leftover tabs can go to "Unsorted" with their priority cleared. Last step
orders folders and tabs like the preset. Every step is verified; the plan is idempotent, so a failed
run can simply be re-applied.

## Auto-sort

Planner (`web/sort.js`): own rules (saved searches -> tab, `data/rules.json`) > game tab priorities
(game order) > fallback (a tab or a whole folder, also used for overflow). Items already in a
matching tab stay. Free space is simulated per tab, top-left first; a second pass retries items that
found no room after later moves freed space. The space forecast groups tabs that share a rule.

Executor (`mover.py`, batch mode):

1. Per source tab: switch once; take as many items as fit into the free inventory space.
2. Priority moves: shift-click stash -> inventory, then inventory -> stash (the game routes them).
3. Rule / fallback moves: cursor stash -> inventory, then one tab switch per target and cursor drop.
4. Verify by item id; anything undeliverable stays in the inventory and the job stops with a message.

## Item names, values and icons

- Game data from `GlobalAssets` master lists + `UniqueList.instance` -> `data/gamedata.json`
  (refreshed when the game build changes). Item name = unique name, or prefix title + subtype +
  suffix title. Affix value = lerp(tier.min, tier.max, roll/255).
- Icons: `ItemData.GetItemSprite(...)` -> `SoftRef<Sprite>{guid, subPath}` ->
  `AssetBundlesManager.catalog.GetObjectLocation` -> bundle file -> UnityPy. Tab icons come from
  `PermaLoad.bundle` (names read from `NewStashTabbedUIControls` while the stash is open).

## Prices

`prices.py` polls `bazaar.leoverlay.com` (no key; 30 req/min; hourly with ETag; idol pages 3 s
apart). Same ids as the game: `uniqueId:LP`, `itemType:affixId:tier(0-based)`, idol affix
combinations. Asking prices only; quotes past `expiresAt` are ignored. Attribution is required and
shown in the page header.

## After a game patch

1. `setup.bat` reports an untested build (`Last Epoch_Data/build_hash.txt`).
2. Run `tools/dev/crud_test.py` with the stash open.
3. If a name changed: `.venv\Scripts\python tools\il2cpp_dump.py dump\LE_dump.cs --images LE.dll`
   and search the dump for the new name (the `dump/` folder is git-ignored: game content).
4. Add the build hash to `supported_builds.json` once checks pass.

## Ideas backlog (from community feedback)

- Loot-filter rules as search / sort criteria; filter colours on stash items.
- Duplicate finder ("worse copy" of the same unique / base).
- Build view: items with a given affix list across all tabs.
- Move history with undo.
- Read-only mode without Frida (external memory reads; no stash changes).
- Affix shard icons; affix picker limited to the selected item type.

## Releasing

1. Bump `VERSION` and add a `## <version>` section to `CHANGELOG.md`.
2. Commit, then tag and push the tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. GitHub Actions (`.github/workflows/release.yml`) checks the tag matches `VERSION`, refuses binary
   files, builds `LE_StashManager-<version>.zip` with `git archive` (CRLF for `.bat`/`.ps1` from
   `.gitattributes`, `.github` excluded), adds a SHA-256 file and publishes the release with the
   changelog section as notes.

`.github/workflows/ci.yml` runs on every push: no binaries, Python compiles, all JavaScript parses,
JSON presets are valid.
