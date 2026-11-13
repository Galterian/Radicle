terraform {
  required_version = ">= 1.5"
  required_providers {
    oci = { source = "oracle/oci", version = ">= 5.30" }
  }
}

provider "oci" {
  config_file_profile = var.oci_profile
  region              = var.region
}

# ----- lookups -----
data "oci_identity_availability_domains" "ads" {
  compartment_id = var.compartment_ocid
}

# Canonical ARM64 Ubuntu 22.04 image for Ampere (A1.Flex).
data "oci_core_images" "ubuntu_arm" {
  compartment_id           = var.compartment_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "22.04"
  shape                    = "VM.Standard.A1.Flex"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

locals {
  ad_name     = data.oci_identity_availability_domains.ads.availability_domains[0].name
  image_id    = data.oci_core_images.ubuntu_arm.images[0].id
  cloud_init  = templatefile("${path.module}/cloud-init.yaml", {
    project_rid       = var.project_rid
    alias             = var.seed_alias
    gossip_port       = var.gossip_port
    http_port         = var.http_port
    hostname_template = var.hostname_template
  })
}

# ----- network -----
resource "oci_core_vcn" "vcn" {
  compartment_id = var.compartment_ocid
  cidr_blocks    = ["10.42.0.0/16"]
  display_name   = "chaosd6-seed-vcn"
  dns_label      = "chaosd6seed"
}

resource "oci_core_internet_gateway" "igw" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn.id
  display_name   = "chaosd6-seed-igw"
}

resource "oci_core_route_table" "rt" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn.id
  display_name   = "chaosd6-seed-rt"
  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.igw.id
  }
}

resource "oci_core_security_list" "sl" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.vcn.id
  display_name   = "chaosd6-seed-sl"

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }

  # SSH — tighten source if you want.
  ingress_security_rules {
    protocol = "6" # TCP
    source   = "0.0.0.0/0"
    tcp_options {
      min = 22
      max = 22
    }
  }
  # Radicle gossip.
  ingress_security_rules {
    protocol = "6"
    source   = "0.0.0.0/0"
    tcp_options {
      min = var.gossip_port
      max = var.gossip_port
    }
  }
  # radicle-httpd (443 via caddy, plus the raw port for debugging / direct).
  ingress_security_rules {
    protocol = "6"
    source   = "0.0.0.0/0"
    tcp_options {
      min = 443
      max = 443
    }
  }
  ingress_security_rules {
    protocol = "6"
    source   = "0.0.0.0/0"
    tcp_options {
      min = 80
      max = 80
    }
  }
  ingress_security_rules {
    protocol = "6"
    source   = "0.0.0.0/0"
    tcp_options {
      min = var.http_port
      max = var.http_port
    }
  }
}

resource "oci_core_subnet" "sn" {
  compartment_id    = var.compartment_ocid
  vcn_id            = oci_core_vcn.vcn.id
  cidr_block        = "10.42.1.0/24"
  display_name      = "chaosd6-seed-sn"
  dns_label         = "pub"
  route_table_id    = oci_core_route_table.rt.id
  security_list_ids = [oci_core_security_list.sl.id]
}

# ----- VM -----
resource "oci_core_instance" "seeder" {
  availability_domain = local.ad_name
  compartment_id      = var.compartment_ocid
  display_name        = var.display_name
  shape               = "VM.Standard.A1.Flex"
  shape_config {
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_gb
  }
  create_vnic_details {
    subnet_id        = oci_core_subnet.sn.id
    assign_public_ip = true
    hostname_label   = "seed"
  }
  source_details {
    source_type = "image"
    source_id   = local.image_id
    boot_volume_size_in_gbs = var.boot_volume_gb
  }
  metadata = {
    ssh_authorized_keys = var.ssh_public_key
    user_data           = base64encode(local.cloud_init)
  }
  preserve_boot_volume = false
}

# ----- outputs -----
output "public_ip" {
  value       = oci_core_instance.seeder.public_ip
  description = "Public IP of the seeder VM. Point your Firebase UI at this."
}

output "sslip_hostname" {
  value       = replace(oci_core_instance.seeder.public_ip, ".", "-") == "" ? "" : "${replace(oci_core_instance.seeder.public_ip, ".", "-")}.sslip.io"
  description = "sslip.io hostname resolving to the public IP (Let's Encrypt-friendly)."
}

output "ssh_command" {
  value = "ssh -i infra/oci/keys/oci_seeder ubuntu@${oci_core_instance.seeder.public_ip}"
}

output "radicle_gossip_addr" {
  value       = "${oci_core_instance.seeder.public_ip}:${var.gossip_port}"
  description = "Append '<nid>@<this>' to preferredSeeds / node.connect after first boot (nid printed via SSH)."
}
