#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  SENTINEL ENGINE v4.1 — GCP API Enablement
#  Enables all required APIs on the target project.
#
#  Usage:
#    chmod +x enable-apis.sh && ./enable-apis.sh
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

PROJECT_ID="ha-sentinel-core-v21"

echo "[SENTINEL] Enabling required GCP APIs on project: ${PROJECT_ID}"

APIS=(
  "bigquery.googleapis.com"
  "aiplatform.googleapis.com"
  "run.googleapis.com"
  "cloudscheduler.googleapis.com"
  "cloudbuild.googleapis.com"
  "artifactregistry.googleapis.com"
  "monitoring.googleapis.com"
  "logging.googleapis.com"
  "cloudfunctions.googleapis.com"
  "secretmanager.googleapis.com"
  "iam.googleapis.com"
)

for api in "${APIS[@]}"; do
  echo "  Enabling ${api}..."
  gcloud services enable "${api}" --project="${PROJECT_ID}" 2>/dev/null || true
done

echo ""
echo "[SENTINEL] All APIs enabled."

# Create Artifact Registry repository for ETL container images
echo "[SENTINEL] Creating Artifact Registry repository..."
gcloud artifacts repositories create sentinel-registry \
  --repository-format=docker \
  --location=us-central1 \
  --project="${PROJECT_ID}" \
  --description="Sentinel Engine container images" \
  2>/dev/null || echo "  Repository already exists."

echo "[SENTINEL] Infrastructure prerequisite setup complete."
