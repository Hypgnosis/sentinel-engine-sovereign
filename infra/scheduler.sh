#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  SENTINEL ENGINE v4.0 — Cloud Scheduler Setup
#  Configures the hourly cron job that triggers the ETL pipeline.
#
#  Prerequisites:
#    - Cloud Run Job 'sentinel-etl' must be deployed first
#    - Cloud Scheduler API enabled
#    - Service account with Cloud Run Invoker role
#
#  Usage:
#    export PROJECT_ID=ha-sentinel-core-prod
#    chmod +x scheduler.sh && ./scheduler.sh
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-ha-sentinel-core-prod}"
REGION="${GCP_REGION:-us-central1}"
JOB_NAME="sentinel-etl"
SCHEDULER_NAME="sentinel-etl-hourly"

# Derive the project number for the Cloud Run service URL
PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format="value(projectNumber)")

# Service account for the scheduler to invoke Cloud Run
SA_EMAIL="sentinel-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  SENTINEL ENGINE v4.0 — Cloud Scheduler Setup           ║"
echo "║  Schedule: Every hour, on the hour (0 * * * *)          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── Step 1: Create service account (if not exists) ──
echo "[1/3] Creating scheduler service account..."
gcloud iam service-accounts create sentinel-scheduler \
  --display-name="Sentinel ETL Scheduler" \
  --project="${PROJECT_ID}" \
  2>/dev/null || echo "  Service account already exists."

# Grant Cloud Run Invoker role
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/run.invoker" \
  --condition="None" \
  --quiet 2>/dev/null || true

# ── Step 2: Create (or update) the scheduler job ──
echo "[2/3] Creating Cloud Scheduler job: ${SCHEDULER_NAME}..."
gcloud scheduler jobs create http "${SCHEDULER_NAME}" \
  --schedule="0 * * * *" \
  --uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB_NAME}:run" \
  --http-method=POST \
  --oauth-service-account-email="${SA_EMAIL}" \
  --location="${REGION}" \
  --project="${PROJECT_ID}" \
  --description="Triggers Sentinel ETL pipeline every hour" \
  --time-zone="UTC" \
  --attempt-deadline="330s" \
  2>/dev/null || {
    echo "  Job exists. Updating..."
    gcloud scheduler jobs update http "${SCHEDULER_NAME}" \
      --schedule="0 * * * *" \
      --uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB_NAME}:run" \
      --http-method=POST \
      --oauth-service-account-email="${SA_EMAIL}" \
      --location="${REGION}" \
      --project="${PROJECT_ID}" \
      --description="Triggers Sentinel ETL pipeline every hour" \
      --time-zone="UTC" \
      --attempt-deadline="330s"
  }

# ── Step 3: Verify ──
echo "[3/3] Verifying scheduler job..."
gcloud scheduler jobs describe "${SCHEDULER_NAME}" \
  --location="${REGION}" \
  --project="${PROJECT_ID}" \
  --format="table(name,schedule,state,httpTarget.uri)"

echo ""
echo "[SENTINEL] Cloud Scheduler configured: ${SCHEDULER_NAME}"
echo "  Schedule: 0 * * * * (every hour UTC)"
echo "  Target:   Cloud Run Job '${JOB_NAME}'"
echo ""
