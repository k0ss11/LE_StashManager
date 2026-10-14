# Changelog

## Unreleased

- One-line installer / updater (`install.ps1`): latest release, SHA-256 check, keeps your data.
- README screenshot gallery.

## 0.2.0

- **Fix:** the game could hang when quitting while StashManager was attached. The agent now only
  registers with the game's runtime during each call and removes its hook when the game quits.
- **First run:** the page offers *Extract item pictures* (game running, about a minute). Tab icons
  follow when the stash is first opened.
- **LAN mode:** `run.bat lan` makes the page reachable from your phone or other PCs, protected by an
  access key.
- **Support:** log file in `data/logs/`, *diagnostics* report for bug reports (key and user name
  redacted).
- **Status:** clear messages when the game isn't running or no character is loaded.
- **Full layout preset:** uniques split by LP (0, 1, 2, 3+) and Weaver's Will, crafting bases and
  dump overflow tabs.
- **Auto-sort:** batch moves through the inventory with the game routing items by tab priority;
  space forecast groups overflow tabs; buy buttons locked while a purchase runs.
- **Prices:** idols (exact affix combinations) and legendary estimates.
- **Prices:** idol fallback only compares listings at equal or lower tiers with the same corruption
  state; stash and tab totals count confident prices only.
- **Docs:** usage guide with screenshots, troubleshooting, developer notes.
- **Releases:** GitHub Actions builds a source-only zip + SHA-256 for every `v*` tag; CI checks
  every push (no binaries, Python compiles, JavaScript parses).

## 0.1.0

- First release: stash viewer with cross-tab search, item art and names, tab / folder configuration
  with tab priorities, presets that reuse existing tabs, auto-sort, market prices.
