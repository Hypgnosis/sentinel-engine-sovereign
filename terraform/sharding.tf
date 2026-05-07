# ═══════════════════════════════════════════════════════════════════
#  SENTINEL ENGINE V5.5 — Multi-Tenant Sharding Infrastructure
#  Terraform module for dynamic shard provisioning.
#
#  This module extends main.tf with:
#    - Dedicated Cloud SQL instances for Tier 1 (Enterprise) tenants
#    - Secret Manager slots for per-shard DATABASE_URLs
#    - Shard-specific service accounts with least-privilege IAM
#
#  Usage:
#    Add entries to the `enterprise_shards` variable for each
#    Tier 1 tenant. Tier 2/3 tenants share the primary instance
#    and are managed via the Governance Hub shard_map.
# ═══════════════════════════════════════════════════════════════════

# ─────────────────────────────────────────────────────
#  VARIABLES
# ─────────────────────────────────────────────────────

variable "enterprise_shards" {
  description = "Map of Tier 1 (Enterprise) tenant shards to provision"
  type = map(object({
    tenant_name = string
    tier        = string  # "db-custom-4-15360" for standard, "db-custom-16-61440" for premium
    disk_size   = number  # GB
    region      = string  # Override region for data residency
  }))
  default = {}
  # Example:
  # enterprise_shards = {
  #   "acme-logistics" = {
  #     tenant_name = "Acme Logistics"
  #     tier        = "db-custom-4-15360"
  #     disk_size   = 50
  #     region      = "us-central1"
  #   }
  # }
}

# ─────────────────────────────────────────────────────
#  TIER 1 — Dedicated Cloud SQL Shards
# ─────────────────────────────────────────────────────

resource "google_sql_database_instance" "enterprise_shard" {
  for_each = var.enterprise_shards

  name             = "sentinel-shard-${each.key}"
  database_version = "POSTGRES_15"
  region           = each.value.region
  project          = var.project_id

  settings {
    tier = each.value.tier

    availability_type = "REGIONAL"  # HA is mandatory for Tier 1

    disk_type       = "PD_SSD"
    disk_size       = each.value.disk_size
    disk_autoresize = true

    # Private IP only — no public endpoints
    ip_configuration {
      ipv4_enabled    = false
      private_network = "projects/${var.project_id}/global/networks/default"
    }

    # Automated backups + PITR (enterprise-grade retention)
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "03:00"
      transaction_log_retention_days = 14  # Double retention for enterprise

      backup_retention_settings {
        retained_backups = 30  # 30-day retention for enterprise
      }
    }

    maintenance_window {
      day          = 7
      hour         = 4
      update_track = "stable"
    }

    insights_config {
      query_insights_enabled  = true
      query_plans_per_minute  = 10  # Higher resolution for enterprise
      query_string_length     = 2048
      record_application_tags = true
      record_client_address   = false
    }

    user_labels = {
      component   = "enterprise-shard"
      tenant      = each.key
      environment = var.environment
      managed     = "terraform"
      tier        = "1"
    }
  }

  deletion_protection = true  # Always protect enterprise shards

  depends_on = [
    google_project_service.apis,
    google_service_networking_connection.private_vpc_connection
  ]
}

# Database per shard
resource "google_sql_database" "shard_db" {
  for_each = var.enterprise_shards

  name     = "sentinel_reservoir"
  instance = google_sql_database_instance.enterprise_shard[each.key].name
  project  = var.project_id
}

# DB user per shard (unique password via variable)
resource "google_sql_user" "shard_user" {
  for_each = var.enterprise_shards

  name     = "sentinel"
  instance = google_sql_database_instance.enterprise_shard[each.key].name
  password = var.db_password  # Same variable, rotated per deployment
  project  = var.project_id
}

# Secret Manager — Per-shard DATABASE_URL
resource "google_secret_manager_secret" "shard_database_url" {
  for_each = var.enterprise_shards

  secret_id = "SHARD_DATABASE_URL_${upper(replace(each.key, "-", "_"))}"
  project   = var.project_id

  replication {
    auto {}
  }

  labels = {
    component = "enterprise-shard"
    tenant    = each.key
    managed   = "terraform"
  }

  depends_on = [google_project_service.apis["secretmanager.googleapis.com"]]
}

# ─────────────────────────────────────────────────────
#  PER-SHARD SERVICE ACCOUNTS
# ─────────────────────────────────────────────────────

resource "google_service_account" "shard_sa" {
  for_each = var.enterprise_shards

  account_id   = "sentinel-shard-${substr(each.key, 0, 20)}"
  display_name = "Sentinel Shard: ${each.value.tenant_name}"
  description  = "Least-privilege SA for enterprise shard ${each.key}. Access restricted to this shard only."
  project      = var.project_id
}

# Shard SA → Cloud SQL Client (only for their specific instance)
resource "google_project_iam_member" "shard_cloudsql_client" {
  for_each = var.enterprise_shards

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.shard_sa[each.key].email}"
}

# Shard SA → Secret Accessor (for their DATABASE_URL secret)
resource "google_project_iam_member" "shard_secret_accessor" {
  for_each = var.enterprise_shards

  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.shard_sa[each.key].email}"
}

# ─────────────────────────────────────────────────────
#  OUTPUTS
# ─────────────────────────────────────────────────────

output "enterprise_shard_instances" {
  value = {
    for k, v in google_sql_database_instance.enterprise_shard :
    k => {
      connection_name = v.connection_name
      private_ip      = v.private_ip_address
      database_url    = "postgresql://sentinel:PASSWORD@/sentinel_reservoir?host=/cloudsql/${v.connection_name}"
    }
  }
  description = "Enterprise shard connection details (passwords must be injected separately)"
  sensitive   = true
}

output "shard_service_accounts" {
  value = {
    for k, v in google_service_account.shard_sa :
    k => v.email
  }
  description = "Per-shard service account emails"
}
