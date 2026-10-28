---
name: chaosd6-env
description: Environment mechanics for the chaosD6 checkout (Windows Claude Code → WSL Ubuntu repo over a UNC path) — how to run node/bash reliably, invoke WSL scripts, patch large files safely (python _patch*.py, Edit tool), avoid CRLF/heredoc/quoting traps, and install npm packages past the stale Artifactory token. Use whenever a shell command fails oddly, before writing a patch, or when installing dependencies.
---

# Environment: Windows host, WSL repo

Repo path (WSL): `/home/galt/repo_radicle/chaosD6-fix`. From Windows bash: `//wsl.localhost/Ubuntu/home/galt/repo_radicle/chaosD6-fix`.
This checkout is a git **worktree**; do not `cd` into the main checkout; never bare `git stash`.

## What works where

| Need | Do this |
|---|---|
| node scripts, `node --check`, effects-check, logic-check, rebalance | Windows node with cwd on the UNC path: `cd "//wsl.localhost/Ubuntu/home/galt/repo_radicle/chaosD6-fix/game" && node tools/x.mjs` |
| `node -e` with `import()` | FAILS on UNC → write a temp `.mjs` file and run it |
| anything with `ps`, `setsid`, `nohup`, sockets, the swarm, npm | run INSIDE WSL: `MSYS_NO_PATHCONV=1 wsl -d Ubuntu -- bash /home/galt/.../script.sh` |
| multi-step shell logic | ALWAYS a script file (e.g. `game/tools/out/_x.sh`, gitignored). Inline `$`, parentheses and quotes break across the Windows→WSL boundary |
| long-running swarm | foreground, `timeout: 600000`; detached `nohup` from a `wsl` call dies with the session |
| recursive grep over the repo | use the Grep tool with a `glob`; `grep -rn` over UNC takes minutes |
| node inside WSL scripts | `for d in "$HOME"/.nvm/versions/node/v2*/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done` (pattern used by every tools/*.sh) |

## Patching big files (peer.mjs 3.5k lines, main.js 1.6k)

- Preferred: Edit tool with a unique anchor. For multi-hunk patches write `game/tools/out/_patchNN.py`:
  ```python
  p = 'game/peer.mjs'; s = open(p, encoding='utf-8').read()
  anchor = "exact unique text"; assert s.count(anchor) == 1, s.count(anchor)
  s = s.replace(anchor, anchor + "\n  new code")
  open(p, 'w', encoding='utf-8', newline='\n').write(s)   # keep LF for code files
  ```
  then `python3 tools/out/_patchNN.py && node --check game/peer.mjs`. Next free number: look at `ls game/tools/out/_patch*.py` (32 used).
- Python heredocs in bash UNESCAPE `\n` inside JS template strings → for strings containing `\n` or backticks use the Edit/Write tool, or `'''…'''` with `\\n`.
- `data/*.json`, `package-lock.json` are CRLF; code files are LF. `writeDataFile()` (logic-engine) preserves the file's own ending; never `JSON.stringify` straight to a data file.
- Verify every patch with `node --check <file>`; UI changes with a quick read of the edited region (no browser needed for most).

## npm in `game/`

`~/.npmrc` has a stale Artifactory `_auth` + `always-auth` and the lockfile pins some tarballs to `artifactory.dowjones.io` → plain `npm install` = E401.
```bash
npm install <pkg> --userconfig /dev/null --registry https://registry.npmjs.org/ --package-lock=false --no-audit --no-fund
```
then add the lock entry manually (see `tools/_lock_jsonlogic.sh` for the json-logic-js precedent: sha512 of the registry tarball, CRLF preserved).

## Logs and scratch

- Swarm logs `game/logs/swarm-HHMM/` (take HHMM from `/tmp/swarm.log`, see skill `chaosd6-swarm-test`). Launcher logs `/tmp/chaos-A.log`, `/tmp/chaos-C.log`.
- `game/tools/out/` is gitignored scratch for patches, summary scripts, rebalance reports (`rebalance-<ts>.json`).
- Memory dir for this project is loaded each session; update `project_rules_pc_overrides.md` for new rulings, `project_logic_layer.md` for logic-layer changes.

## Git

Branch `master`; user commits themselves — do not commit or push unless asked. Many tracked `.sh`/asset files show as modified (mode/CRLF noise); do not "clean them up".
