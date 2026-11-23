#!/usr/bin/env bash
# Set up a chaosD6 DESKTOP node from scratch so this machine can play: tools, a Radicle identity wired to the chaosD6
# seed, all 6 repos, the game checkout with its npm packages, a launcher. Linux or Windows WSL2 (Ubuntu 22.04/24.04);
# macOS works with --no-apt if git, curl, jq, python3 are installed.
#
#   curl -fsSLO <this file> && bash setup-desktop.sh            # fresh machine (no checkout yet)
#   tools/setup-desktop.sh [options]                            # from an existing checkout (re-run = update)
#
# Steps (each idempotent):
#   1. apt packages: git curl jq python3 python3-venv build-essential screen xz-utils ca-certificates (sudo)
#   2. Node 22 via nvm (the game needs >= 18; system Node 16 on old Ubuntu is too old)
#   3. Radicle CLI + node (radicle.xyz/install) into ~/.radicle/bin, PATH line in ~/.bashrc
#   4. `rad auth` — creates YOUR identity if missing (asks for a passphrase; empty = no prompt later, weaker)
#   5. ~/.radicle/config.json: the seed in preferredSeeds + node.connect, privacy policy like the reference desktop
#      (peers static = connect only to the seed, seedingPolicy block + explicit seeds below), then `rad node start`
#   6. repos: `rad clone` chaosD6 (Code) into --dir; seed + fetch Dimensions, Effects, Skills, Classes (scope all)
#      and Profiles (scope followed) from the seed only
#   7. game/: npm install (public registry, ignores any ~/.npmrc token)
#   8. optional: --with-llm  llama-server + Qwen3-1.7B for AI bots (tools/llm/llm-desktop.sh install, ~1.2 GB)
#               --dev       python venv with tools/requirements.txt (asset tools)
#   9. ~/.config/chaosd6/env (seed variables) + ~/.local/bin/chaosd6-play (starts the launcher on :7357)
#
# Options
#   --dir PATH          checkout location (default ~/chaosD6, or the checkout this script lives in)
#   --seed NID@HOST:PORT  the seed node (default the live chaosD6 OCI seed)
#   --alias NAME        Radicle alias for a new identity (default $USER)
#   --branch NAME       git branch to check out after cloning (default: the repo's default branch)
#   --with-llm  --dev  --no-apt  --no-start (do not start the rad node / launcher test)
set -euo pipefail

SEED="z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT@92-5-138-121.sslip.io:8776"
CODE_RID="rad:zqZmP6itceBMqYwi1K1n8phQqCaj"
# name rid scope
OTHER_REPOS="Dimensions:rad:z2xbfJfwT3kukR73m8LXmmuvchEwr:all Effects:rad:z9X3fYPnz8QZnBmfnCaoY73zeKRZ:all Skills:rad:z2L7U9KeYdiynSmeg9gNoE84BP3i5:all Classes:rad:zBCekM1pp1DM1WcVZFFXWH3FGXsi:all Profiles:rad:z4Y11mZyhHRbkHMGN98w5gPwTWTFH:followed"
NODE_MAJOR=22
HERE="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$HERE/../game/peer.mjs" ]; then DIR="$(cd "$HERE/.." && pwd)"; else DIR="$HOME/chaosD6"; fi
ALIAS="${USER:-player}"; BRANCH=""; WITH_LLM=0; DEV=0; APT=1; START=1
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift ;;
    --seed) SEED="$2"; shift ;;
    --alias) ALIAS="$2"; shift ;;
    --branch) BRANCH="$2"; shift ;;
    --with-llm) WITH_LLM=1 ;;
    --dev) DEV=1 ;;
    --no-apt) APT=0 ;;
    --no-start) START=0 ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
case "$SEED" in z6Mk*@*:*) ;; *) echo "--seed must look like z6Mk…@host:8776" >&2; exit 2 ;; esac
SEED_NID="${SEED%%@*}"; SEED_ADDR="${SEED#*@}"; SEED_HOST="${SEED_ADDR%:*}"
say() { printf '\n== %s\n' "$*"; }

# ------------------------------------------------------------------ 1. packages
if [ "$APT" = 1 ]; then
  say "apt packages (sudo)"
  command -v apt-get >/dev/null || { echo "no apt-get — install git curl jq python3 build tools yourself and re-run with --no-apt" >&2; exit 2; }
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl jq python3 python3-venv build-essential screen xz-utils ca-certificates >/dev/null
fi
for c in git curl jq python3; do command -v $c >/dev/null || { echo "missing $c" >&2; exit 2; }; done

# ------------------------------------------------------------------ 2. node
say "Node $NODE_MAJOR (nvm)"
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | PROFILE=/dev/null bash >/dev/null
fi
set +u; . "$NVM_DIR/nvm.sh"
nvm ls "$NODE_MAJOR" >/dev/null 2>&1 || nvm install "$NODE_MAJOR" >/dev/null
nvm use "$NODE_MAJOR" >/dev/null; set -u
NODE_BIN="$(dirname "$(command -v node)")"
echo "node $(node -v) at $NODE_BIN"
grep -q 'NVM_DIR' "$HOME/.bashrc" 2>/dev/null || printf '\nexport NVM_DIR="$HOME/.nvm"\n[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"\n' >> "$HOME/.bashrc"

# ------------------------------------------------------------------ 3. radicle
say "Radicle"
export PATH="$HOME/.radicle/bin:$PATH"
if ! command -v rad >/dev/null || ! command -v radicle-node >/dev/null; then
  curl -sSfL https://radicle.xyz/install | sh | tail -3
fi
grep -q '.radicle/bin' "$HOME/.bashrc" 2>/dev/null || printf '\nexport PATH="$HOME/.radicle/bin:$PATH"\n' >> "$HOME/.bashrc"
rad --version

# ------------------------------------------------------------------ 4. identity
if [ ! -f "$HOME/.radicle/keys/radicle" ]; then
  say "rad auth — your Radicle identity (alias $ALIAS)"
  echo "   Choose a passphrase (or leave it empty). With a passphrase run 'rad auth' once per session before playing."
  rad auth --alias "$ALIAS"
fi
MY_NID="$(rad self --nid)"
echo "your NID: $MY_NID"

# ------------------------------------------------------------------ 5. node config
say "node config: seed $SEED_NID@$SEED_ADDR"
CFG="$HOME/.radicle/config.json"
[ -f "$CFG" ] || rad config init --alias "$ALIAS" >/dev/null 2>&1 || echo '{}' > "$CFG"
cp "$CFG" "$CFG.bak-$(date +%Y%m%dT%H%M%S)"
jq --arg s "$SEED_NID@$SEED_ADDR" '
    .preferredSeeds = ([$s] + ((.preferredSeeds // []) - [$s]))
  | .node = (.node // {})
  | .node.connect = ([$s] + ((.node.connect // []) - [$s]))
  | .node.peers = {type: "static"}
  | .node.seedingPolicy = {default: "block", scope: "followed"}
' "$CFG" > "$CFG.new" && jq -e . "$CFG.new" >/dev/null && mv "$CFG.new" "$CFG"
jq -c '{preferredSeeds, node: (.node | {connect, peers, seedingPolicy})}' "$CFG"
if [ "$START" = 1 ]; then
  rad node stop >/dev/null 2>&1 || true; sleep 1
  rad node start >/dev/null 2>&1 || rad node start
  sleep 3
  rad node connect "$SEED_NID@$SEED_ADDR" --timeout 20s 2>&1 | tail -1 || echo "   (could not reach the seed yet — check your network; continuing)"
fi

# ------------------------------------------------------------------ 6. repos
say "repos (fetched from the seed only)"
if [ -d "$DIR/.git" ]; then
  echo "checkout $DIR exists — fetching"
  rad seed "$CODE_RID" --scope all --no-fetch >/dev/null 2>&1 || true
  rad sync --fetch "$CODE_RID" --seed "$SEED_NID" --timeout 120sec 2>&1 | tail -1 || true
  git -C "$DIR" fetch --all -q 2>/dev/null || true
  git -C "$DIR" diff --quiet && git -C "$DIR" pull --ff-only -q 2>/dev/null || echo "   (local changes or no upstream — not pulling)"
else
  mkdir -p "$(dirname "$DIR")"
  rad clone "$CODE_RID" "$DIR" --scope all --seed "$SEED_NID" --timeout 10min
fi
if [ -n "$BRANCH" ]; then git -C "$DIR" checkout -q "$BRANCH" && echo "on branch $BRANCH"; fi
for spec in $OTHER_REPOS; do
  name="${spec%%:*}"; rest="${spec#*:}"; scope="${rest##*:}"; rid="${rest%:*}"
  rad seed "$rid" --scope "$scope" --no-fetch >/dev/null 2>&1 || true
  printf '   %-11s %s  ' "$name" "$rid"
  rad sync --fetch "$rid" --seed "$SEED_NID" --timeout 120sec 2>&1 | tail -1 || echo "fetch failed (re-run later)"
done

# ------------------------------------------------------------------ 7. npm
say "npm install (game/)"
(cd "$DIR/game" && npm install --userconfig /dev/null --registry https://registry.npmjs.org/ --no-audit --no-fund 2>&1 | tail -2)
node --check "$DIR/game/peer.mjs" && echo "peer.mjs parses"

# ------------------------------------------------------------------ 8. optional
if [ "$DEV" = 1 ]; then
  say "python venv for the asset tools ($DIR/.venv)"
  python3 -m venv "$DIR/.venv" && "$DIR/.venv/bin/pip" install -q -r "$DIR/tools/requirements.txt" && echo "activate: . $DIR/.venv/bin/activate"
fi
if [ "$WITH_LLM" = 1 ]; then
  say "llama-server for AI bots (tools/llm/llm-desktop.sh install)"
  if [ -f "$DIR/tools/llm/llm-desktop.sh" ]; then bash "$DIR/tools/llm/llm-desktop.sh" install
  else echo "   this checkout has no tools/llm/llm-desktop.sh — skipped (bots then play by rules only, LLM_URL=0)"; fi
fi

# ------------------------------------------------------------------ 9. env + launcher
say "launcher"
mkdir -p "$HOME/.config/chaosd6" "$HOME/.local/bin"
cat > "$HOME/.config/chaosd6/env" <<EOF
# chaosD6 desktop node — written by tools/setup-desktop.sh ($(date -u +%F))
export PATH="$NODE_BIN:\$HOME/.radicle/bin:\$PATH"
export OCI_SEED_NID=$SEED_NID
export OCI_SEED_ADDR=$SEED_ADDR
export CHAOSD6_OCI_SEED_NID=$SEED_NID
export RADICLE_SEED=$SEED_HOST
EOF
cat > "$HOME/.local/bin/chaosd6-play" <<EOF
#!/usr/bin/env bash
# Start the chaosD6 launcher (http://127.0.0.1:7357). Extra args go to start-all.mjs (e.g. --list).
. "\$HOME/.config/chaosd6/env"
rad node status >/dev/null 2>&1 || rad node start
cd "$DIR/game" && exec node start-all.mjs "\$@"
EOF
chmod +x "$HOME/.local/bin/chaosd6-play"
grep -q '.local/bin' "$HOME/.bashrc" 2>/dev/null || printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME/.bashrc"

cat <<EOF

============================================================================
chaosD6 desktop node ready.
  checkout   $DIR
  identity   $MY_NID   (alias $(rad self --alias 2>/dev/null || echo "$ALIAS"))
  seed       $SEED_NID@$SEED_ADDR
Play:        chaosd6-play          → open http://127.0.0.1:7357   (new shell, or: . ~/.bashrc)
             chaosd6-play --list   → every Dimension on Radicle and who is live
If your key has a passphrase: run 'rad auth' once per session first (publishing doors / votes signs with it).
Team identity: in the launcher's startup menu set your team name (the rules editor and proposals need it).
Status:      rad node status ; rad sync status $CODE_RID
============================================================================
EOF
