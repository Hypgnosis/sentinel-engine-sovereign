# ═══════════════════════════════════════════════════════════════════
#  SENTINEL ENGINE v5.5 — Terraform Infrastructure (Sovereign)
#  Project: ha-sentinel-core-v21
#
#  Provisions: APIs, Service Accounts, IAM, Secret Manager,
#              Artifact Registry, and Cloud SQL (Pristine Reservoir).
#
#  V5.5: Sovereign Infrastructure (GCP Native).
#         Private IP only. pgvector enabled. HA for production.
# ═══════════════════════════════════════════════════════════════════

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.0"
    }
  }

  # Remote state in GCS (create bucket manually first)
  # backend "gcs" {
  #   bucket = "ha-sentinel-terraform-state"
  #   prefix = "sentinel-engine/v55"
  # }
}

# ─────────────────────────────────────────────────────
#  VARIABLES
# ─────────────────────────────────────────────────────

variable "project_id" {
  description = "GCP Project ID"
  type        = string
  default     = "ha-sentinel-core-v21"
}

variable "region" {
  description = "Default GCP region"
  type        = string
  default     = "us-central1"
}

variable "alert_email" {
  description = "Engineering alert email"
  type        = string
  default     = "engineering@high-archy.tech"
}

variable "environment" {
  description = "Deployment environment: 'staging' or 'production'"
  type        = string
  default     = "staging"
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Environment must be 'staging' or 'production'."
  }
}

variable "db_password" {
  description = "Cloud SQL postgres user password (injected via CI/CD or -var)"
  type        = string
  sensitive   = true
  default     = ""
}

# ─────────────────────────────────────────────────────
#  PROVIDER
# ─────────────────────────────────────────────────────

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

# ─────────────────────────────────────────────────────
#  API ENABLEMENT
# ─────────────────────────────────────────────────────

resource "google_project_service" "apis" {
  for_each = toset([
    "bigquery.googleapis.com",
    "aiplatform.googleapis.com",
    "run.googleapis.com",
    "cloudscheduler.googleapis.com",
    "cloudbuild.googleapis.com",
    "artifactregistry.googleapis.com",
    "monitoring.googleapis.com",
    "logging.googleapis.com",
    "cloudfunctions.googleapis.com",
    "secretmanager.googleapis.com",
    "iam.googleapis.com",
    "sqladmin.googleapis.com",
    "servicenetworking.googleapis.com",
    "compute.googleapis.com",
  ])

  service            = each.value
  disable_on_destroy = false
}

# ─────────────────────────────────────────────────────
#  SERVICE ACCOUNTS
# ─────────────────────────────────────────────────────

resource "google_service_account" "etl_sa" {
  account_id   = "sentinel-etl-sa"
  display_name = "Sentinel ETL Pipeline"
  description  = "Least-privilege SA for the Sentinel ETL Cloud Run Job. Writes to BigQuery and Cloud SQL, reads secrets."
  project      = var.project_id
}

resource "google_service_account" "inference_sa" {
  account_id   = "sentinel-inference-sa"
  display_name = "Sentinel Inference Function"
  description  = "Least-privilege SA for the Sentinel Cloud Function. Reads BigQuery, Cloud SQL, calls Vertex AI, reads secrets."
  project      = var.project_id
}

# ── ETL SA Bindings ──

resource "google_project_iam_member" "etl_bq_editor" {
  project = var.project_id
  role    = "roles/bigquery.dataEditor"
  member  = "serviceAccount:${google_service_account.etl_sa.email}"
}

resource "google_project_iam_member" "etl_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.etl_sa.email}"
}

resource "google_project_iam_member" "etl_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.etl_sa.email}"
}

# ── Inference SA Bindings ──

resource "google_project_iam_member" "inference_bq_viewer" {
  project = var.project_id
  role    = "roles/bigquery.dataViewer"
  member  = "serviceAccount:${google_service_account.inference_sa.email}"
}

resource "google_project_iam_member" "inference_ai_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.inference_sa.email}"
}

resource "google_project_iam_member" "inference_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.inference_sa.email}"
}

resource "google_project_iam_member" "inference_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.inference_sa.email}"
}

# ─────────────────────────────────────────────────────
#  NETWORKING — Private Service Access (VPC Peering)
# ─────────────────────────────────────────────────────

resource "google_compute_global_address" "private_ip_address" {
  name          = "sentinel-private-ip-address"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = "projects/${var.project_id}/global/networks/default"
}

resource "google_service_networking_connection" "private_vpc_connection" {
  network                 = "projects/${var.project_id}/global/networks/default"
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip_address.name]

  depends_on = [google_project_service.apis]
}

# ═══════════════════════════════════════════════════════════════════
#  CLOUD SQL — PRISTINE RESERVOIR (V5.5 Sovereign Infrastructure)
# ═══════════════════════════════════════════════════════════════════

resource "google_sql_database_instance" "pristine_reservoir" {
  name             = "sentinel-reservoir"
  database_version = "POSTGRES_15"
  region           = var.region
  project          = var.project_id

  settings {
    tier = var.environment == "production" ? "db-custom-16-61440" : "db-f1-micro"

    # HA: Regional availability for production (automatic failover)
    availability_type = var.environment == "production" ? "REGIONAL" : "ZONAL"

    disk_type       = "PD_SSD"
    disk_size       = var.environment == "production" ? 100 : 10
    disk_autoresize = true

    # Private IP only — no public endpoints
    ip_configuration {
      ipv4_enabled    = false
      private_network = "projects/${var.project_id}/global/networks/default"
    }

    # Removed cloudsql.enable_pgvector flag as it's best enabled 
    # via CREATE EXTENSION vector; in the migration script.
    
    # Automated backups + PITR
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "03:00"  # 3 AM UTC
      transaction_log_retention_days = 7

      backup_retention_settings {
        retained_backups = 14
      }
    }

    # Maintenance window (Sunday 4 AM UTC)
    maintenance_window {
      day          = 7
      hour         = 4
      update_track = "stable"
    }

    insights_config {
      query_insights_enabled  = true
      query_plans_per_minute  = 5
      query_string_length     = 1024
      record_application_tags = true
      record_client_address   = false
    }

    user_labels = {
      component   = "pristine-reservoir"
      environment = var.environment
      managed     = "terraform"
    }
  }

  deletion_protection = var.environment == "production" ? true : false

  depends_on = [
    google_project_service.apis,
    google_service_networking_connection.private_vpc_connection
  ]
}

# Database
resource "google_sql_database" "sentinel_db" {
  name     = "sentinel_reservoir"
  instance = google_sql_database_instance.pristine_reservoir.name
  project  = var.project_id
}

# DB User (password injected via variable)
resource "google_sql_user" "sentinel_user" {
  name     = "sentinel"
  instance = google_sql_database_instance.pristine_reservoir.name
  password = var.db_password
  project  = var.project_id
}

# ─────────────────────────────────────────────────────
#  SECRET MANAGER — Slots for Sensitive Keys
# ─────────────────────────────────────────────────────

resource "google_secret_manager_secret" "gemini_api_key" {
  secret_id = "GEMINI_API_KEY"
  project   = var.project_id

  replication {
    auto {}
  }

  labels = {
    component = "inference"
    managed   = "terraform"
  }

  depends_on = [google_project_service.apis["secretmanager.googleapis.com"]]
}

resource "google_secret_manager_secret" "freightos_api_key" {
  secret_id = "FREIGHTOS_API_KEY"
  project   = var.project_id

  replication {
    auto {}
  }

  labels = {
    component = "etl"
    managed   = "terraform"
  }

  depends_on = [google_project_service.apis["secretmanager.googleapis.com"]]
}

resource "google_secret_manager_secret" "xeneta_api_key" {
  secret_id = "XENETA_API_KEY"
  project   = var.project_id

  replication {
    auto {}
  }

  labels = {
    component = "etl"
    managed   = "terraform"
  }

  depends_on = [google_project_service.apis["secretmanager.googleapis.com"]]
}

resource "google_secret_manager_secret" "database_url" {
  secret_id = "DATABASE_URL"
  project   = var.project_id

  replication {
    auto {}
  }

  labels = {
    component = "inference"
    managed   = "terraform"
  }

  depends_on = [google_project_service.apis["secretmanager.googleapis.com"]]
}

resource "google_secret_manager_secret" "system_pepper" {
  secret_id = "SYSTEM_PEPPER"
  project   = var.project_id

  replication {
    auto {}
  }

  labels = {
    component = "security"
    managed   = "terraform"
  }

  depends_on = [google_project_service.apis["secretmanager.googleapis.com"]]
}

# ─────────────────────────────────────────────────────
#  ARTIFACT REGISTRY — Container Images
# ─────────────────────────────────────────────────────

resource "google_artifact_registry_repository" "sentinel_registry" {
  location      = var.region
  repository_id = "sentinel-registry"
  format        = "DOCKER"
  description   = "Sentinel Engine container images"
  project       = var.project_id

  depends_on = [google_project_service.apis["artifactregistry.googleapis.com"]]
}

# ─────────────────────────────────────────────────────
#  OUTPUTS
# ─────────────────────────────────────────────────────

output "etl_service_account" {
  value       = google_service_account.etl_sa.email
  description = "Email of the ETL service account"
}

output "inference_service_account" {
  value       = google_service_account.inference_sa.email
  description = "Email of the Inference service account"
}

output "cloud_sql_instance_connection_name" {
  value       = google_sql_database_instance.pristine_reservoir.connection_name
  description = "Cloud SQL instance connection name (for INSTANCE_CONNECTION_NAME)"
}

output "cloud_sql_private_ip" {
  value       = google_sql_database_instance.pristine_reservoir.private_ip_address
  description = "Cloud SQL private IP address"
}

output "database_url_template" {
  value       = "postgresql://sentinel:PASSWORD@/sentinel_reservoir?host=/cloudsql/${google_sql_database_instance.pristine_reservoir.connection_name}"
  description = "DATABASE_URL template for Cloud SQL socket connection"
  sensitive   = true
}

output "secret_gemini" {
  value       = google_secret_manager_secret.gemini_api_key.name
  description = "Secret Manager resource name for GEMINI_API_KEY"
}

output "secret_freightos" {
  value       = google_secret_manager_secret.freightos_api_key.name
  description = "Secret Manager resource name for FREIGHTOS_API_KEY"
}

output "secret_xeneta" {
  value       = google_secret_manager_secret.xeneta_api_key.name
  description = "Secret Manager resource name for XENETA_API_KEY"
}
