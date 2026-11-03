variable "oci_profile" {
  type        = string
  default     = "DEFAULT"
  description = "Profile section inside ~/.oci/config to drive the deploy with."
}

variable "region" {
  type        = string
  default     = "eu-frankfurt-1"
  description = "OCI region. Overrides whatever ~/.oci/config has."
}

variable "compartment_ocid" {
  type        = string
  description = "Compartment to deploy into. Root compartment = your tenancy OCID."
}

variable "ssh_public_key" {
  type        = string
  description = "SSH public key (one line) authorised on the VM's ubuntu user. The paired `terraform apply` reads this from terraform.tfvars."
}

variable "ocpus" {
  type        = number
  default     = 2
  description = "A1.Flex OCPUs. Always Free quota: 4 across your Ampere fleet."
}

variable "memory_gb" {
  type        = number
  default     = 12
  description = "A1.Flex memory in GB. Always Free quota: 24 across your Ampere fleet."
}

variable "boot_volume_gb" {
  type        = number
  default     = 50
  description = "Boot volume size in GB. Default 50 is well inside the 200 GB free quota."
}

variable "project_rid" {
  type        = string
  default     = "rad:zqZmP6itceBMqYwi1K1n8phQqCaj"
  description = "The chaosD6 project RID the seeder tracks with --scope all."
}

variable "seed_alias" {
  type        = string
  default     = "chaos-oci-seed"
  description = "Alias advertised by the Radicle node."
}

variable "gossip_port" {
  type        = number
  default     = 8776
  description = "Radicle gossip (TCP). Added to the VCN security list."
}

variable "http_port" {
  type        = number
  default     = 8080
  description = "radicle-httpd listen port behind caddy. caddy terminates TLS on 443 and reverse-proxies here."
}

variable "proxy_http_ports" {
  type        = list(number)
  default     = [8081, 8082, 8083, 8084, 8085, 8090]
  description = "Extra radicle-httpd / proxy TCP ports to open on the firewall. Matches the ports radicle-httpd-start.sh accepts."
}

variable "gossip_extra_ports" {
  type        = list(number)
  default     = [8777, 8778, 8779]
  description = "Extra Radicle gossip ports (beyond gossip_port) to open, matching local-seeds.mjs' three-seed layout."
}

variable "display_name" {
  type        = string
  default     = "chaosd6-seed"
  description = "VM display name shown in the OCI console."
}

variable "hostname_template" {
  type        = string
  default     = "sslip"
  description = "`sslip` → <ip-dashed>.sslip.io (public DNS, no setup); or a hostname you own that already resolves to the VM's public IP."
}
