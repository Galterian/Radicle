#!/usr/bin/env bash
# Set up a NEW chaosD6 Radicle seed (an OCI VM, or any Ubuntu 22.04+/24.04 server with a public IP) the way the
# live seed 92-5-138-121.sslip.io is set up, from your workstation (WSL/Linux/macOS, repo root of a chaosD6 checkout).
#
#   infra/oci/new-seed.sh --host ubuntu@<public-ip> [options]
#   infra/oci/new-seed.sh --terraform [options]          # create the VM first with terraform (infra/oci/deploy.sh)
#
# What it does
#   1. preflight: ssh key, ssh reachability, sudo on the VM
#   2. provision: copies infra/oci/seed-provision.sh to the VM and runs it (radicle-node + radicle-httpd + caddy +
#      firewall + private-seed policy + pins), fetching all 6 repos from the upstream seed
#   3. content (static /var/www): rules site, asset pack, Android APK (see --content)
#   4. optional: llama-server for AI bots (--with-llm / --llm-public, via infra/oci/llm-setup.sh)
#   5. optional: an OWN chaosD6-Profiles repo + its /profiles-push endpoint (--own-profiles, via profiles-setup.sh)
#   6. writes infra/oci/seeder-<host>.json and prints how players point their nodes at the new seed
#
# Prerequisites
#   - an Ubuntu VM with a public IP, ssh access as a sudo user (OCI images: `ubuntu`), and in the cloud firewall
#     (OCI: VCN security list) TCP 22, 80, 443 and 8776 open. `--terraform` creates exactly that (main.tf); it needs
#     terraform, ~/.oci/config (OCI API key) and infra/oci/terraform.tfvars (copy terraform.tfvars.example).
#   - an ssh key pair: --key <private key> (default infra/oci/keys/oci_seeder, else ~/.ssh/id_ed25519, ~/.ssh/id_rsa);
#     its .pub must be in the VM's ~ubuntu/.ssh/authorized_keys (OCI: pasted at instance creation / tfvars).
#   - locally: bash, ssh, scp, tar, curl; node >= 18 for the rules site build (else that step is skipped).
#   - the domain: none needed — <ip-dashed>.sslip.io resolves to the IP and Let's Encrypt issues for it.
#     A real hostname: --hostname seed.example.org with its DNS A record pointing at the IP.
#
# Options
#   --host USER@IP          the VM (required unless --terraform)
#   --key PATH              ssh private key
#   --hostname FQDN         public hostname (default <ip-dashed>.sslip.io)
#   --alias NAME            node alias (default chaos-seed-<host>)
#   --email ADDR            Let's Encrypt e-mail (default admin@sslip.io)
#   --upstream NID@H:P|none seed to mirror the repos from (default the live OCI seed)
#   --upstream-www URL      where pack/APK are mirrored from (default https://92-5-138-121.sslip.io)
#   --content LIST          comma list of rules,pack,apk | all | none   (default all)
#   --pack-source upstream|local   pack: download on the VM from --upstream-www (default) or rsync this checkout's assets
#   --with-llm | --llm-public      install llama-server (loopback | + /llm route with an API key)
#   --own-profiles          create a NEW chaosD6-Profiles repo delegated to this seed (independent deployment only;
#                           a mirror just seeds the existing Profiles repo)
#   --force-caddy           rewrite the caddy site even if the VM already has one
#   --dry-run               print the plan, change nothing
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"

HOSTSPEC=""; KEY=""; HOSTNAME_ARG=""; ALIAS_ARG=""; EMAIL="admin@sslip.io"
UPSTREAM="z6MknLjCKCXpzUoAEJArdxnjz2EbFoR3usfMornTh1FHK2zT@92-5-138-121.sslip.io:8776"
UPSTREAM_WWW="https://92-5-138-121.sslip.io"
CONTENT="all"; PACK_SOURCE="upstream"; LLM=""; OWN_PROFILES=0; FORCE_CADDY=0; DRY=0; TF=0
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOSTSPEC="$2"; shift ;;
    --key) KEY="$2"; shift ;;
    --hostname) HOSTNAME_ARG="$2"; shift ;;
    --alias) ALIAS_ARG="$2"; shift ;;
    --email) EMAIL="$2"; shift ;;
    --upstream) UPSTREAM="$2"; shift ;;
    --upstream-www) UPSTREAM_WWW="${2%/}"; shift ;;
    --content) CONTENT="$2"; shift ;;
    --pack-source) PACK_SOURCE="$2"; shift ;;
    --with-llm) LLM=local ;;
    --llm-public) LLM=public ;;
    --own-profiles) OWN_PROFILES=1 ;;
    --force-caddy) FORCE_CADDY=1 ;;
    --terraform) TF=1 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *) echo "unknown option $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done
[ "$CONTENT" = all ] && CONTENT="rules,pack,apk"
[ "$CONTENT" = none ] && CONTENT=""
has() { case ",$CONTENT," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

# ------------------------------------------------------------------ 0. key + host
if [ -z "$KEY" ]; then
  for k in infra/oci/keys/oci_seeder "$HOME/.ssh/id_ed25519" "$HOME/.ssh/id_rsa"; do [ -f "$k" ] && { KEY="$k"; break; }; done
fi
[ -n "$KEY" ] && [ -f "$KEY" ] || { echo "no ssh private key — pass --key (generate one: ssh-keygen -t ed25519 -f infra/oci/keys/oci_seeder -N '')" >&2; exit 2; }
chmod 600 "$KEY" 2>/dev/null || true

if [ "$TF" = 1 ]; then
  command -v terraform >/dev/null || { echo "terraform not installed" >&2; exit 2; }
  [ -f infra/oci/terraform.tfvars ] || { echo "create infra/oci/terraform.tfvars from terraform.tfvars.example first (compartment_ocid, ssh_public_key = content of ${KEY}.pub)" >&2; exit 2; }
  if [ "$DRY" = 1 ]; then echo "[dry-run] would run: infra/oci/deploy.sh init && infra/oci/deploy.sh apply"
  else
    bash infra/oci/deploy.sh init
    bash infra/oci/deploy.sh apply
    HOSTSPEC="ubuntu@$(cd infra/oci && terraform output -raw public_ip)"
    echo "VM created: $HOSTSPEC — waiting 90 s for cloud-init/sshd"; sleep 90
  fi
fi
[ -n "$HOSTSPEC" ] || { echo "--host USER@IP is required (or --terraform)" >&2; exit 2; }
case "$HOSTSPEC" in *@*) ;; *) HOSTSPEC="ubuntu@$HOSTSPEC" ;; esac
SSH_OPTS=(-i "$KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o ServerAliveInterval=30)
rsh() { ssh "${SSH_OPTS[@]}" "$HOSTSPEC" "$@"; }

echo "== plan"
echo "   vm $HOSTSPEC  key $KEY  hostname ${HOSTNAME_ARG:-<ip>.sslip.io}  upstream $UPSTREAM"
echo "   content: ${CONTENT:-none} (pack from $PACK_SOURCE)  llm: ${LLM:-no}  own profiles: $OWN_PROFILES"
if [ "$DRY" = 1 ]; then echo "[dry-run] nothing changed"; exit 0; fi

# ------------------------------------------------------------------ 1. preflight
echo "== preflight"
rsh 'set -e; . /etc/os-release; echo "   $PRETTY_NAME $(uname -m), $(nproc) cpu, $(free -g | awk "/Mem:/{print \$2}") GB"; sudo -n true && echo "   sudo ok"' \
  || { echo "!! cannot ssh/sudo to $HOSTSPEC with $KEY" >&2; exit 1; }

# ------------------------------------------------------------------ 2. provision
echo "== provision (infra/oci/seed-provision.sh on the VM — takes a few minutes)"
scp "${SSH_OPTS[@]}" infra/oci/seed-provision.sh "$HOSTSPEC:/tmp/seed-provision.sh" >/dev/null
rsh "HOST='$HOSTNAME_ARG' ALIAS='$ALIAS_ARG' ACME_EMAIL='$EMAIL' UPSTREAM='$UPSTREAM' FORCE_CADDY='$FORCE_CADDY' bash /tmp/seed-provision.sh"
SEED_JSON="$(rsh 'sudo cat /home/radicle/seeder.json')"
PUB_HOST="$(printf '%s' "$SEED_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hostname"])')"
NID="$(printf '%s' "$SEED_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["nid"])')"
OUT="infra/oci/seeder-$PUB_HOST.json"
printf '%s\n' "$SEED_JSON" > "$OUT"
echo "   saved $OUT"

# ------------------------------------------------------------------ 3. content
if has rules; then
  echo "== rules site (/rules/)"
  B="$(mktemp -d)"
  if [ -f game/tools/rules-site-build.mjs ] && command -v node >/dev/null; then
    (cd game && node tools/rules-site-build.mjs --out "$B/site") | tail -2
  elif [ -f editor.html ]; then
    echo "   (no rules-site-build.mjs in this checkout — plain copy: editor.html as rules.html + data/)"
    mkdir -p "$B/site" && cp editor.html "$B/site/rules.html" && cp editor.html "$B/site/editor.html" && cp -r data "$B/site/data"
    [ -d editor ] && cp -r editor "$B/site/editor"
  fi
  if [ -d "$B/site" ]; then
    tar -C "$B/site" -czf "$B/rules.tgz" .
    scp "${SSH_OPTS[@]}" "$B/rules.tgz" "$HOSTSPEC:/tmp/rules.tgz" >/dev/null
    rsh 'set -e; sudo rm -rf /var/www/rules.new; sudo mkdir -p /var/www/rules.new; sudo tar -C /var/www/rules.new -xzf /tmp/rules.tgz
         sudo rm -rf /var/www/rules; sudo mv /var/www/rules.new /var/www/rules; sudo chown -R "$(id -un)":"$(id -gn)" /var/www/rules; echo "   $(find /var/www/rules -type f | wc -l) files"'
  else echo "   skipped (nothing to publish)"; fi
  rm -rf "$B"
fi

if has pack; then
  echo "== asset pack (/pack/, from $PACK_SOURCE)"
  if [ ! -f godot/assets_manifest.json ]; then echo "   skipped: no godot/assets_manifest.json in this checkout"
  elif [ "$PACK_SOURCE" = local ]; then
    command -v rsync >/dev/null || { echo "   rsync not installed locally" >&2; exit 1; }
    rsh 'command -v rsync >/dev/null || sudo apt-get install -y -qq rsync >/dev/null'
    LIST="$(mktemp)"
    python3 - godot/assets_manifest.json > "$LIST" <<'PY'
import json, os, sys
for e in json.load(open(sys.argv[1]))["entries"]:
    p = e["path"]
    if p.endswith(".bmp") and not os.path.exists(p) and os.path.exists(p[:-4] + ".png"): p = p[:-4] + ".png"
    if os.path.exists(p): print(p)
PY
    echo "   $(wc -l < "$LIST") files"
    rsync -a --relative --files-from="$LIST" -e "ssh ${SSH_OPTS[*]}" ./ "$HOSTSPEC:/var/www/pack/"
    rm -f "$LIST"
  else
    scp "${SSH_OPTS[@]}" godot/assets_manifest.json "$HOSTSPEC:/tmp/assets_manifest.json" >/dev/null
    rsh "UP='$UPSTREAM_WWW' python3 - /tmp/assets_manifest.json" <<'PY'
import json, os, sys, urllib.parse, urllib.request, concurrent.futures as cf
up = os.environ["UP"].rstrip("/") + "/pack/"
entries = json.load(open(sys.argv[1]))["entries"]
def get(e):
    p = e["path"]; dst = os.path.join("/var/www/pack", p)
    if os.path.exists(dst) and (not e.get("size") or os.path.getsize(dst) == e["size"]): return "have"
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    url = up + "/".join(urllib.parse.quote(s) for s in p.split("/"))
    try:
        with urllib.request.urlopen(url, timeout=60) as r, open(dst + ".part", "wb") as f: f.write(r.read())
        os.replace(dst + ".part", dst); return "got"
    except Exception as ex:
        return "miss " + p + " (" + str(ex)[:60] + ")"
res = list(cf.ThreadPoolExecutor(8).map(get, entries))
miss = [r for r in res if r.startswith("miss")]
print(f"   {res.count('have')} already there, {res.count('got')} downloaded, {len(miss)} missing")
for m in miss[:10]: print("   " + m)
PY
  fi
fi

if has apk; then
  echo "== Android APK (/downloads/chaosd6-release.apk)"
  if [ -f _tools/chaosd6-release.apk ] && [ "$PACK_SOURCE" = local ]; then
    scp "${SSH_OPTS[@]}" _tools/chaosd6-release.apk "$HOSTSPEC:/var/www/downloads/chaosd6-release.apk" >/dev/null && echo "   uploaded from _tools/"
  else
    rsh "curl -sSfL -m 600 -o /var/www/downloads/chaosd6-release.apk.part '$UPSTREAM_WWW/downloads/chaosd6-release.apk' && mv /var/www/downloads/chaosd6-release.apk.part /var/www/downloads/chaosd6-release.apk && ls -l /var/www/downloads/chaosd6-release.apk | awk '{print \"   \" \$5 \" bytes\"}' || echo '   no APK at $UPSTREAM_WWW'"
  fi
fi

# ------------------------------------------------------------------ 4./5. optional services (existing scripts)
if [ -n "$LLM" ]; then
  echo "== llama-server (infra/oci/llm-setup.sh)"
  SSH_KEY="$KEY" OCI_HOST="$HOSTSPEC" bash infra/oci/llm-setup.sh $([ "$LLM" = public ] && echo --public)
fi
if [ "$OWN_PROFILES" = 1 ]; then
  echo "== own chaosD6-Profiles (infra/oci/profiles-setup.sh)"
  SSH_KEY="$KEY" OCI_HOST="$HOSTSPEC" bash infra/oci/profiles-setup.sh
fi

# ------------------------------------------------------------------ 6. checks + wiring
echo "== checks from here (Let's Encrypt may need a minute on the first run)"
sleep 5
for p in /api/v1 /api/v1/repos /rules/ /downloads/; do
  printf '   %-16s %s\n' "$p" "$(curl -s -m 20 -o /dev/null -w '%{http_code}' "https://$PUB_HOST$p" || echo fail)"
done
printf '   gossip %-9s %s\n' "8776" "$( (exec 3<>"/dev/tcp/${HOSTSPEC#*@}/8776") 2>/dev/null && echo open || echo 'CLOSED (cloud firewall / security list?)')"

cat <<EOF

============================================================================
NEW SEED: $NID@$PUB_HOST:8776      api https://$PUB_HOST/      (saved in $OUT)

Players / desktop nodes: set it up with
  tools/setup-desktop.sh --seed $NID@$PUB_HOST:8776
or add it by hand to ~/.radicle/config.json (preferredSeeds + node.connect) and export
  OCI_SEED_NID=$NID  OCI_SEED_ADDR=$PUB_HOST:8776  CHAOSD6_OCI_SEED_NID=$NID  RADICLE_SEED=$PUB_HOST

Keep it in sync: this seed lists the upstream in node.connect, so new refs arrive over gossip. Desktops that publish
(dimensions, votes, definitions) should announce to it too:  rad sync --announce <rid> --seed $NID --replicas 1
For a permanent two-way link also add "$NID@$PUB_HOST:8776" to node.connect on the upstream seed.
============================================================================
EOF
