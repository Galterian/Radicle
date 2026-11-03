#!/usr/bin/env bash
# One-shot wrapper around terraform for the chaosD6 OCI seeder. Run from the
# repo root on WSL:
#
#   infra/oci/deploy.sh init                 # terraform init (one-off)
#   infra/oci/deploy.sh plan                 # show what will be created/changed
#   infra/oci/deploy.sh apply                # actually create the VM (paid resources!)
#   infra/oci/deploy.sh output               # print IP, sslip host, SSH command
#   infra/oci/deploy.sh ssh                  # ssh ubuntu@<ip> with the generated key
#   infra/oci/deploy.sh status               # radicle service + nid + sslip host
#   infra/oci/deploy.sh destroy              # tear everything down
#
# First time: `cp terraform.tfvars.example terraform.tfvars`, paste your
# compartment OCID + SSH pubkey, then run `init` and `plan`.

set -euo pipefail
cd "$(dirname "$0")"

PUBKEY_PATH="keys/oci_seeder.pub"
PRIVKEY_PATH="keys/oci_seeder"

ensure_tfvars() {
  if [ ! -f terraform.tfvars ]; then
    echo "terraform.tfvars not found — copying from the example"
    cp terraform.tfvars.example terraform.tfvars
    if [ -f "$PUBKEY_PATH" ]; then
      PUBKEY=$(cat "$PUBKEY_PATH")
      sed -i "s|^ssh_public_key.*|ssh_public_key = \"${PUBKEY}\"|" terraform.tfvars
      echo "ssh_public_key filled from $PUBKEY_PATH"
    fi
    echo "edit terraform.tfvars (compartment_ocid at minimum) and re-run."
    exit 2
  fi
}

cmd="${1:-plan}"
case "$cmd" in
  init)
    terraform init
    ;;
  plan)
    ensure_tfvars
    terraform plan -out=tfplan
    ;;
  apply)
    ensure_tfvars
    terraform apply -auto-approve
    terraform output
    ;;
  output)
    terraform output
    ;;
  ssh)
    IP=$(terraform output -raw public_ip)
    ssh -i "$PRIVKEY_PATH" -o StrictHostKeyChecking=accept-new "ubuntu@$IP"
    ;;
  status)
    IP=$(terraform output -raw public_ip)
    ssh -i "$PRIVKEY_PATH" -o StrictHostKeyChecking=accept-new "ubuntu@$IP" '
      echo "== hostname: $(cat /home/radicle/public-hostname.txt 2>/dev/null)"
      echo "== nid:      $(cat /home/radicle/node-nid.txt 2>/dev/null)"
      sudo systemctl --no-pager status radicle-node.service | head -4
      sudo systemctl --no-pager status radicle-httpd.service | head -4
      sudo systemctl --no-pager status caddy.service | head -3
    '
    ;;
  destroy)
    read -rp "destroy the OCI seeder VM and its VCN? type yes: " ok
    [ "$ok" = "yes" ] || { echo "aborted"; exit 1; }
    terraform destroy -auto-approve
    ;;
  *)
    echo "usage: $0 {init|plan|apply|output|ssh|status|destroy}"
    exit 2
    ;;
esac
