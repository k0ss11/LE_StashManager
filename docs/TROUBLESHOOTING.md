# Troubleshooting

## Reporting a problem

Open **diagnostics** (link in the page header, or <http://127.0.0.1:8100/api/diagnostics>) and attach
its text to a GitHub issue. It contains StashManager / Python / Frida versions, your game build, the
connection state and the recent log. It never contains your access key, account or stash contents,
and your Windows user name is replaced with `%USERPROFILE%`.

The full log is `data/logs/stashmanager.log` (rotates at 2 MB, 5 files kept).

## Common problems

| Symptom | Fix |
|---|---|
| Page says **no game** | Start Last Epoch and load a character; the page reconnects by itself. Run `run.bat` again if the server window was closed. |
| **stash closed** although you are at the stash | Open the stash panel in game (it closes when you walk away). |
| Buttons that change things are greyed out | They need the stash open in game. |
| `setup.bat`: Python not found | Install Python 3.11–3.13 from python.org with "Add python.exe to PATH" ticked, then re-run. |
| `setup.bat`: pip errors about compilers / "Microsoft Visual C++" | Your Python is newer than the packages' prebuilt files. Use Python 3.11–3.13 (see below). |
| `setup.bat`: game not found | `setup.bat -GamePath "D:\SteamLibrary\steamapps\common\Last Epoch"` |
| `setup.bat`: build **not tested** | Usually still works. Open the stash and run `.venv\Scripts\python tools\dev\crud_test.py` (spends no gold). Please open an issue with its output if something fails. |
| Antivirus warns about Frida | Frida is an instrumentation tool and is sometimes flagged. It is installed from PyPI; the only code it loads into the game is `agent/agent.js` from this repository. |
| Items show no picture | Click **Extract item pictures** in the banner (game running), or run `.venv\Scripts\python tools\extract_icons.py`. Tab icons appear after the stash was opened once. |
| No prices / old prices | The price feed may be down or rate-limited; cached prices are used until it is back. Check <https://www.leoverlay.com>. |
| Auto-sort: "inventory is full" | Free some inventory space; batches use your free inventory space. |
| Auto-sort stopped with an item "in your inventory" | Nothing is lost: put it back with shift-click, then run Auto-sort again. It re-plans from the current state. |
| Game hangs when quitting while StashManager runs | Fixed: the agent no longer keeps a thread registered with the game. If it ever happens again, close the `run.bat` window; the game then finishes quitting. Please report it. |
| Phone / other PC can't open the page | Start with `run.bat lan` and open the link it prints (with `?key=`) once on that device. Allow Python through Windows Firewall for **Private** networks. Use the address marked "main network". |
| A preset run stopped halfway | Apply the same preset again; finished steps are skipped. |
| Something looks wrong after a game patch | See [DEVELOPMENT.md](DEVELOPMENT.md#after-a-game-patch). |

## Does anything need compiling?

No. The repository is plain text: Python, JavaScript, HTML, PowerShell and batch files.

- Python and JavaScript run as they are; `agent/agent.js` is loaded by Frida at runtime.
- The two dependencies, `frida` and `UnityPy`, are installed by `setup.bat` from PyPI as
  ready-made packages for your Python version. With a Python newer than the packages support, pip
  would try to build them from source and fail without a C++ compiler. Use Python 3.11–3.13.
