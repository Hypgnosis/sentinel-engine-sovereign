# ═══════════════════════════════════════════════════════════════════
#  SENTINEL V5.5 — Sharding Terraform Variables
# ═══════════════════════════════════════════════════════════════════

variable "project_id" {
  description = "GCP Project ID for the Sentinel Governance Hub."
  type        = string
  default     = "ha-sentinel-core-v21"
}

variable "region" {
  description = "GCP region for Tier 1 shard instances."
  type        = string
  default     = "us-central1"
}

variable "vpc_id" {
  description = "VPC network self_link for private IP peering. The sovereignProxy (Cloud Functions/Run) must be in this VPC or have a VPC connector attached."
  type        = string
}

variable "service_account_email" {
  description = "Service account email for IAM-authenticated Cloud SQL access (without @project.iam.gserviceaccount.com suffix for Cloud SQL IAM users)."
  type        = string
  default     = "sentinel-inference-sa"
}

variable "tier_1_tenants" {
  description = "Map of Tier 1 Enterprise tenant keys to their configuration. Each key provisions a dedicated Cloud SQL instance."
  type = map(object({
    tenant_name         = string
    max_queries_per_min = optional(number, 500)
    storage_limit_gb    = optional(number, 100)
  }))
  default = {}

  # Example usage in tenants.tfvars:
  # tier_1_tenants = {
  #   "acme-logistics" = {
  #     tenant_name = "ACME Global Logistics"
  #   }
  #   "maritime-alpha" = {
  #     tenant_name         = "Maritime Alpha Corp"
  #     max_queries_per_min = 1000
  #     storage_limit_gb    = 200
  #   }
  # }
}

variable "alert_notification_channels" {
  description = "List of Cloud Monitoring notification channel IDs for disk/IOPS alerts."
  type        = list(string)
  default     = []
}
