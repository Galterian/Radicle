# infra/oci — chaosD6 Radicle seeder on Oracle Cloud

A 24/7 Radicle seed node for the chaosD6 dimensions mesh, running on an
Always-Free-eligible OCI Ampere A1 VM. No rosa, no iris — your own.

## What this deploys

- One `VM.Standard.A1.Flex` (ARM64), Ubuntu 22.04, public IP.
- VCN + Internet Gateway + security list opening 22 (ssh), 80/443 (caddy/LE),
  8080 (radicle-httpd debug), 8776 (radicle gossip).
- cloud-init installs `rad` + `radicle-node` + `radicle-httpd` from
  `radicle.xyz/install`, creates a `radicle` user with its own unencrypted
  identity, pins `node.seedingPolicy.default = allow`, seeds
  `rad:zqZmP6itceBMqYwi1K1n8phQqCaj` with `--scope all`.
- Two systemd units (`radicle-node.service`, `radicle-httpd.service`) with
  `Restart=always`.
- caddy terminates TLS on `<ip-dashed>.sslip.io` and reverse-proxies to
  radicle-httpd on 127.0.0.1:8080.

## One-time setup

```sh
cd infra/oci
cp terraform.tfvars.example terraform.tfvars
# edit terraform.tfvars: compartment_ocid is OK as the tenancy OCID shown in
# ~/.oci/config; paste the content of keys/oci_seeder.pub as ssh_public_key.
terraform init
```

## Deploy

```sh
terraform plan        # review before paying for anything
terraform apply       # ~2 minutes to create, ~5 minutes for cloud-init to finish
terraform output      # public_ip, sslip_hostname, ssh_command
```

Then SSH in to read the node's NID (needed for `preferredSeeds`):

```sh
ssh -i keys/oci_seeder ubuntu@$(terraform output -raw public_ip) \
  'cat /home/radicle/public-hostname.txt /home/radicle/node-nid.txt'
```

## Wire the mesh to it

1. **Workstation** — append to `~/.radicle/config.json`:
   ```json
   "preferredSeeds": ["chaos-oci-seed@<sslip-host>:8776"],
   "node": { "connect": ["<nid>@<sslip-host>:8776"], ... }
   ```
2. **Firebase UI** — in `firebase/public/radicle/`, point the explorer's
   `apiBase` at `https://<sslip-host>/` (caddy terminates TLS and proxies to
   radicle-httpd). The CORS allow-origin is pre-set to
   `https://dimensions-4e9ae.web.app`.
3. **Firebase seed registry** — the OCI node is just another peer from
   Firestore's perspective. On first boot the systemd unit publishes
   `{nid, radicleAddr}` the same way local peers do (adapter is loaded via
   `game/radicle-adapter.mjs`'s Firebase hook — set `FIREBASE_PROJECT_ID`
   and `FIREBASE_API_KEY` on the VM once if you want it visible in `/explore`).

## Teardown

```sh
terraform destroy
```

Removes the VM, its boot volume, the VNIC, VCN, IGW, and the security list.
Nothing persists on OCI except logs retained by the console history service.

## Why sslip.io

`dimensions-4e9ae.web.app` is a Firebase-controlled hostname — Firebase won't
delegate it to a 3rd-party IP, and even if it did, Firebase terminates TLS and
can't carry the gossip TCP port. `<ip-dashed>.sslip.io` resolves to the same
IP via public DNS at no cost and no DNS admin, and Let's Encrypt issues
certs against it, so the Firebase UI (HTTPS) can call the OCI API without
mixed-content errors.

Swap it later for a real hostname by setting `hostname_template` in
`terraform.tfvars` to the FQDN and pointing its DNS at the public IP.
