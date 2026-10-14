# LE StashManager

A local web page for managing your **Last Epoch** stash: search every tab at once, see item
prices, set up whole stash layouts in one go, and let it sort your items into the right tabs.

Source code only. No executables or DLLs from this repository; everything you run is readable
Python, JavaScript and HTML.

> **Not affiliated with or endorsed by Eleventh Hour Games.** Read [Safety](#safety) before using it
> on an online character.

![Main page](docs/images/overview.svg)

## Why this exists

This is **not a cheat** and not meant to hack the game. It gives no advantage in play: no map
reveal, no loot or combat automation, nothing outside the stash.

I just want a normal stash interface that the game doesn't offer (yet): search across all tabs,
see what my items are worth, set up tabs once instead of every season, and put items where they
belong without hundreds of clicks. I want to spend my time playing Last Epoch, not
doom-clicking through stash tabs.

Every action it takes is one the stash UI already offers (move an item, configure or buy a tab),
sent the same way the game's own buttons send it.

## What it does

- **See your whole stash** in the browser, with the game's own item art (extracted from *your*
  local game files), names, affixes, tiers and roll ranges.
- **Search all tabs at once**: affix picker with exact names, minimum tier / roll %, "at least N
  affixes of tier X" (e.g. two T7s), item type, rarity, LP / WW / FP, open prefix/suffix, minimum
  price. Saved searches.
- **Prices**: estimated value per item, per tab and for the whole stash, from the public
  [Last Epoch Overlay](https://www.leoverlay.com/developers) feed (uniques by LP, exalted affixes,
  idol combinations).
- **Manage tabs and folders** like the in-game Configure Tab window: name, icon, colour, folder,
  order, and every tab-priority condition, with a live "matches N items" preview. Buy tabs (asks
  twice and shows the gold cost).
- **Presets**: save your layout, import/export it as JSON, or apply a built-in one (a compact
  8-tab starter, or a full community layout). Applying **reuses your existing tabs first** (by
  name, then by what they already contain) and only buys what is missing. Your previous layout is
  backed up automatically.
- **Auto-sort**: moves items into the tab whose rule they match, the same way the game decides
  (tab priorities checked left to right), plus your own rules built from searches (e.g.
  "T7 Health body armour -> tab X"), with an overflow folder for everything else. Shows the plan and
  a **space forecast** (which tabs will be full, one-click overflow tab) before anything moves.
  Moves run in batches through your inventory and every move is verified.

## Requirements

- Windows, Last Epoch (Steam).
- [Python 3.11–3.13](https://www.python.org/downloads/) (tick "Add python.exe to PATH").
- Nothing to compile: see [Does anything need compiling?](docs/TROUBLESHOOTING.md#does-anything-need-compiling)
- Optional: [Node.js](https://nodejs.org/) only for `tools/apply_preset.js` (command-line presets).

## Install

```bat
setup.bat
```

`setup.bat` checks your Python version, creates a private environment in `.venv`, installs the
pinned packages from PyPI (`frida`, `UnityPy`), finds Last Epoch through Steam, checks
your game build against the [tested builds](supported_builds.json) and writes `config.json`.

## Use

1. Start Last Epoch and load your character.
2. Run `run.bat`. It opens <http://127.0.0.1:8100>. (`run.bat lan` = also reachable from your phone /
   other devices in your network, protected by an access key.)
3. Viewing and searching work anywhere. Anything that **changes** the stash (moving items,
   configuring or buying tabs) needs the **stash open in game**; the page shows "at stash" when it is.
4. On first start the page offers **Extract item pictures** (game running, about a minute). It reads
   the art from your local game files; nothing is downloaded.

Full guide with screenshots: **[docs/USAGE.md](docs/USAGE.md)**. Problems:
[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## How it works

```
browser (127.0.0.1:8100)  <->  host.py (Python)  <->  agent/agent.js  (inside the game, via Frida)
```

- **Reading** (tabs, items, gold): plain memory reads of the game's own data structures,
  found by class and field name at runtime (so most game patches don't break it).
- **Changing** (move, configure, buy): `agent.js` queues each action and runs it on the game's
  main thread through the game's own functions, the same requests the stash UI sends. The server
  stays authoritative; StashManager only asks.
- The web server listens on **127.0.0.1 only** by default and rejects requests from other websites.
  `run.bat lan` opens it to your network; every other device then needs the access key.
- Logs go to `data/logs/` (access key and Windows user name redacted); the **diagnostics** link
  gives a ready-to-paste report for bug reports.
- The only outside connection is the price feed (`bazaar.leoverlay.com`), polled at most hourly.
  Nothing about your account or stash is sent anywhere.

## Safety

- **Game rules.** Modifying or automating the game client is against Last Epoch's Terms of
  Service. Using this on an online character is **at your own risk**, including account action.
  Try it offline first.
- **Frida.** StashManager uses [Frida](https://frida.re) (installed from PyPI by `setup.bat`) to
  load `agent/agent.js` into the game process. Some antivirus programs flag Frida because it is an
  instrumentation tool. All the code it runs is `agent/agent.js` in this repository.
- **Gold.** Buying tabs spends gold and tabs cannot be deleted in Last Epoch. Every purchase asks
  for confirmation and shows the cost first.
- **Moves.** Each move is checked against the game; on any error it stops and puts the cursor
  item back. Items in transit are always in your stash or inventory.

## After a game patch

1. `setup.bat` reports whether your build is in `supported_builds.json`.
2. Open the stash and run `.venv\Scripts\python tools\dev\crud_test.py` (spends no gold; every
   change is reverted). If something fails, please open an issue with its output.
3. Game data (names, affixes) refreshes automatically. For new item art run
   `.venv\Scripts\python tools\extract_icons.py` (game running).

## Credits

- Price data: **[Last Epoch Overlay](https://www.leoverlay.com/developers)** (community-observed
  asking prices, not sales).
- Built-in "full layout" preset inspired by community stash guides (Artem's layout).
- Item art and game data are extracted from your own installation at runtime and are not part of
  this repository.

## For developers

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for how the stash works inside the game, the
verified actions, and research notes. `tools/il2cpp_dump.py` dumps class layouts from the running
game (Unity 6 / metadata v39). Development checks live in `tools/dev/`
(`crud_full_test.py --buy` **spends gold**).

## License

[MIT](LICENSE). Covers this source code only, not Last Epoch's files, art or data.
