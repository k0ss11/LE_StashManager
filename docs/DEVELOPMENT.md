# StashManager — plan

Local web page to view, search, organize Last Epoch stash. No MelonLoader.
Verified against Season 5 build (Unity 6, metadata v39) on 2026-10-07.

## How stash works in LE (from live dump `dump/LE_dump.cs`)

**Data (client memory, full copy even when stash closed):**
```
ItemContainersManager._instance            (static 0x8)
  .stash 0xA8 -> StashHolderItemContainer
      .stashItemContainers 0x18 -> StashItemContainer[]   (one per stash: softcore/hardcore/solo...)
      .CurrentStashIndex 0x20
  StashItemContainer : TabbedItemContainer
      .currentlyActiveTab 0x1C
      .containers 0x20 -> List<ItemContainer>              (one per tab, 12x17 grid)
  ItemContainer.content 0x28 -> List<ItemContainerEntry>
  ItemContainerEntry: data 0x10 (ItemData), Position 0x18 (Vector2Int), size 0x20, quantity 0x28
  ItemData: itemType 0x2C, subType 0x2E, rarity 0x30, uniqueID 0x32, corrupted 0x34,
            forgingPotential 0x18, legendaryPotential 0x20, weaversWill 0x21,
            implicitRolls 0x38, uniqueRolls 0x40, affixes 0x50 -> List<ItemAffix>
  ItemDataUnpacked: LvlReq 0x90, SetId 0x98, _fullName 0xB0 (lazy, often null)
  ItemAffix: affixId 0x10 (u16), affixTier 0x12 (0-based), affixRoll 0x13 (0-255), affixName 0x20

Tab/folder metadata (online client):
LocalPlayer.instance (static 0x0) .stashInfo 0x148 -> ClientStashInfo
  .categories 0x10 -> List<StashCategory>  (id 0x10, icon 0x14, color 0x18, name 0x20, order 0x28, folderPriority 0x30)
  .tabs 0x18 -> List<StashTab>             (id 0x68, categoryId 0x6C, icon 0x70, color 0x74, name 0x78, order 0x80, priority 0x88, ignoreFolderPriority 0x90)
```

**Native features already in game:** folders (categories), tab icon/color/name, per-tab and
per-folder `StashPriority` auto-stash rules (rarity, type, class, level, faction, uniques,
corruption, potential), sort tab, duplicate tab/folder, stash merge.
Missing natively: affix-based rules, cross-tab search, bulk reorganize, presets.

**Server-authoritative.** Client UI only sends requests (`PlayerSync`, static `local` @0x0):
| Action | Client call |
|---|---|
| switch tab | `SendTrySwitchToTab(ContainerID, tabId)` |
| pick item to cursor | `SendPickupItemToCursor(ContainerID, pos)` |
| drop from cursor | `SendTryDropItemFromCursor(ContainerID, pos, attemptSwap, destPos, itemToPickPos)` |
| stash <-> inventory | `SendTryManualQuickMove(src, dst, pos)` |
| buy tab | `SendStashTabPurchase(stashIdx, parentId, order, name, copyFromTabId)` |
| configure tab (+priority) | `SendStashTabConfigure(stashIdx, tabId, icon, color, parentId, name, priority, ignoreFolderPrio)` |
| folder create/config/delete/reorder | `SendStashCategoryCreate/Configure/Delete/Reorder` |
| move tab to folder | `SendStashTabUpdateParent` |
| sort tab | `SendStashSort(stashIdx, tabId)` |

Higher level wrappers: `StashManager.RequestPurchaseNewTab / RequestNewFolder / ConfigureTab / RequestSort`.
ContainerID: INVENTORY=1, CURSOR=19, STASH=21.

## Architecture

```
browser (127.0.0.1:8100)  <->  host.py (Python: frida + aiohttp, serves web/)  <->  agent.js (Frida, in game)
```
- **agent.js read path:** pure memory reads (safe from any thread) -> JSON snapshot of tabs/items.
- **agent.js write path:** command queue drained inside a hooked main-thread Update
  (never call managed methods from Frida thread — crashes game). One command per frame,
  re-read state after each, abort on mismatch.
- Cross-tab move = switch tab -> pickup to cursor -> switch tab -> drop at free spot. Rate limited.

## Live CRUD confirmation (2026-10-07, tools/crud_test.py, 18/19 pass, stash restored)
| Op | Agent call | Result |
|---|---|---|
| folder create / rename+color / delete | PlayerSync.SendStashCategoryCreate / Configure / Delete | PASS |
| tab rename / color / move to folder | PlayerSync.SendStashTabConfigure (parentId) | PASS |
| tab move to folder | PlayerSync.SendStashTabUpdateParent | FAIL (no effect) - use Configure |
| switch tab | TabbedItemContainer.TrySwitchToTab(i, true) | PASS (SendTrySwitchToTab alone does nothing client side) |
| move item within tab / across tabs | SendPickupItemToCursor + TrySwitchToTab + SendTryDropItemFromCursor | PASS |
| stash <-> inventory | SendTryManualQuickMove | PASS (inventory->stash lands per tab priority) |
| tab purchase | SendStashTabPurchase | PASS (17,500 gold for tab #11; cost = StashHelpers.NextTabCost(tabCount)) |
| tab icon / reorder in folder | SendStashTabConfigure / SendStashTabReorder | PASS |
| folder icon / reorder | SendStashCategoryConfigure / SendStashCategoryReorder | PASS |

Full run tools/crud_full_test.py --buy: 26/26 PASS. Gold: LocalPlayer.goldTracker.value (client).

Notes: container index == tab id. Cursor = OneSlotItemContainer, single entry @0x28.
Near stash: UIBase.IsStashOpen() (main thread). Panel auto-closes on walking away
(OpenStash.OnTriggerExit), so open == near. Host refuses write ops when closed.

## Run
```
python StashManager/tools/extract_icons.py   # item icons -> data/icons (needs UnityPy, no -I; rerun after patch)
python StashManager/host.py      # http://127.0.0.1:8100
python StashManager/tools/crud_test.py   # stash must be open
python StashManager/tools/il2cpp_dump.py out.cs --images LE.dll   # after game patch
```

## Phases
1. **Read-only viewer + search** (DONE v1: web/index.html) — snapshot tabs/items, render grids, search by name / affix /
   tier / roll / rarity / type / LP / WW. Zero game interaction.
2. **Names DB** (DONE): read live from GlobalAssets.MasterItemsList / MasterAffixesList and
   UniqueList.instance -> data/gamedata.json (auto-refresh when GameAssembly.dll size changes).
   Item name = unique name, or prefix title + subtype + suffix title (game style). Affix value =
   lerp(tier.min, tier.max, roll/255). Exalted = magic/rare with T6+ (ItemData.isExaltedItem).
3. **Tab management** — create/rename/recolor tabs & folders, apply native StashPriority.
4. **Presets** — save layout (folders, tabs, rules) as JSON, apply to new stash/cycle.
5. **Auto-sort** — rules (incl. affix rules) -> move plan, preview in UI, execute throttled.

## Community ideas backlog (LE forums / Steam / YouTube, 2026-10)

Native search already has: `/regex/`, macros (`T7`, `2T6+`, `LP3+`, `WW20+`, `prefixes1`), `!` NOT,
`&` / `|`. Users' complaints with it = our opportunities:

Search
- Structured affix search: pick affix + min tier + min roll % (no regex, no tier-range lookup) — `T7:dexterity`
- Multi-affix conditions: "2+ affixes T7", "T7 X AND T6+ Y", total tier sum, open prefix/suffix
- Roll % shown and sortable (affixRoll 0-255 -> % of tier range)
- Exclude implicits / mod explanation text from matches (native search hits tooltip text)
- Saved searches (native search wiped on every open, 256 char cap)
- Idols: group by same prefix/suffix, sort by roll value
- Uniques: LP/WW filter, "near max roll" per unique
- Loot-filter rule as search/sort criterion (import LE filter XML), show filter color on stash items

Organization
- Stash templates / presets: save tabs+folders+names+colors+icons+priorities, re-apply on new season
  (most requested; currently rebuilt by hand every cycle)
- Bulk move by rule across many tabs ("all T7 exalted helmets -> tab X"), preview first
- Loot-filter-rule based routing (exalted categories to separate tabs)
- Affix-based tab priorities (native priorities can't do affixes)
- Smarter sort: pack 2-wide items without gaps; sort by type/affix/roll
- Find empty / near-empty tabs, cleanup of old season tabs
- Duplicate finder (same unique / same base+affixes), "worse copy" suggestions

Presets (user idea 2026-10-07)
- Apply preset by REUSING existing tabs/folders first: compute folders/tabs the preset needs,
  map onto current ones (prefer empty or matching-name tabs, then least-used), rename/recolor/
  re-prioritize them, move folders; only buy the shortfall (show gold cost before confirm).

Overview
- Whole-stash index: counts per type/rarity/unique, where each item lives
- Build view: items useful for a given build (affix list) across all tabs
- Change log: what moved where (undo plan)

Out of scope / not possible client side: bigger tabs, scrollable tab pages, free tabs.

## Risks
- Online mode: modifying client / automated actions against LE ToS. Test on offline character first.
- Server may reject moves when stash UI closed / player not near stash — must verify in phase 3.

## Item icons (2026-10-07)
ItemData.GetItemSprite(type, sub, isUnique, uniqueId, ctx) -> SoftRef<Sprite>{guid, subPath};
AssetBundlesManager._instance.catalog.GetObjectLocation(guid, subPath) -> (BundleId, objIndex);
GetBundleFileName(BundleId) -> StreamingAssets/LEAssetBundles/assets_*.bundle; UnityPy reads Sprite
named subPath. 1392 images / 1543 items (all bases + 487/489 uniques; affix shards not mapped).

## Tab / folder priority (auto-stash rules) - 2026-10-07
StashPriority = 8 optional condition objects; "Tab Priority" checkbox == HasValue (empty -> stored null).
Agent: readPriority() from memory (HashSet _slots {hash,next,value} stride 12), buildPriority(spec) on
main thread (object_new + .ctor + field writes + HashSet/List Add), passed to SendStashTabConfigure /
SendStashCategoryConfigure. Verified round trip via server on tab 10.
spec = { potential:{MinLegendaryPotential..MaxForgingPotential}, rarity:<flags NORMAL1 MAGIC2 RARE4 UNIQUE8
SET16 LEGENDARY32 EXALTED64>, type:{types:[baseId], subTypes:[]}, classReq:<Primalist1 Mage2 Sentinel4
Acolyte8 Rogue16>, level:{min,max}, faction:[FactionID], uniques:[uniqueId], corruption:<0 any 1 only 2 none> }
Folders have NO priority in the current game UI (server ignores folder priority) - tab priority only.
Auto-sort MUST honour tab priorities: an item goes to the tab whose priority matches.

## Presets (phase 4) - 2026-10-07
presets/*.json (built-in: starter 8 tabs, Artem-style 19 tabs) + data/presets/*.json (user). web/presets.js:
capture current layout, import/export JSON, plan = folders by name -> reuse other folders -> create;
tabs by name -> content-aware reuse (tab already holding most items the preset tab's priority matches)
-> emptiest spare -> buy (cost via StashHelpers.NextTabCost per tab). Leftover tabs -> "Unsorted" +
clear their priority (options). Final step orders folders/tabs like the preset: game routes items
LEFT TO RIGHT, first matching priority tab wins (community guides) - auto-sort must use same order.
Each step verified against game state; stops on first failure; re-running continues (idempotent plan).

## Auto-sort (phase 5) - 2026-10-07
web/sort.js plans, mover.py (host background job) executes. Precedence: own rules (saved searches ->
tab, data/rules.json, ordered) > game tab priorities in game order > fallback tab (also overflow when
targets full). Item already in a matching tab stays. Free space simulated per tab (top-left first).
Executor per move: re-check item by id, switchTab -> pickup -> verify cursor id -> switchTab -> drop ->
verify id at target; any failure: returnCursor + stop. ~3 s/item. Endpoints /api/job-start|job|job-cancel.
Verified live: 2 moves Exalted Weapons -> Exalted Armour.

## Market prices - 2026-10-14
prices.py polls Last Epoch Overlay public API (bazaar.leoverlay.com, no key, 30 req/min, hourly + ETag,
cache data/prices/). Same IDs as game: uniqueId+LP, itemType(=base type):affixId:tier(zero-based).
Attribution required (header link). web/prices.js: item price (unique by id+LP; magic/rare/exalted =
best priced affix), per-tab + total value, grid price tags >= 50k, tooltip line, "price >=" filter.
Asking prices only; quotes past expiresAt ignored.
tools/apply_preset.js: CLI preset apply using the page's planner code (--dry, --wait-open).
