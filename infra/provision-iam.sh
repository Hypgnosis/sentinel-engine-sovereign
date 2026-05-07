#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# ██████████████████████████████████████████████████████████████████
# ██  DEPRECATED — V5.1 SOVEREIGN ABSOLUTE                       ██
# ██  All IAM bindings are now managed in terraform/main.tf.      ██
# ██  This script is retained for reference only.                 ██
# ██  DO NOT execute in production. Use: cd terraform && tf apply  ██
# ██████████████████████████████████████████████████████████████████
#
#  SENTINEL ENGINE v5.0 — IAM Service Account Provisioning (LEGACY)
#  Creates least-privilege service accounts for production workloads.
#
#  Service Accounts:
#    1. sentinel-etl-sa       — ETL pipeline (BigQuery write, Secret read)
#    2. sentinel-inference-sa — Cloud Function (BigQuery read, Vertex AI)
#
#  Principle: Zero standing privilege. Each component gets only the
#  IAM roles it needs. No shared service accounts.
#
#  Usage: DEPRECATED. Use terraform/main.tf instead.
# ═══════════════════════════════════════════════════════════════════

echo "⚠️  WARNING: This script is DEPRECATED as of V5.1."
echo "   All IAM bindings are now managed in terraform/main.tf."
echo "   Run: cd terraform && terraform init && terraform apply"
echo ""
echo "   Exiting. To force execution, remove this guard."
exit 0

set -euo pipefail

PROJECT_ID="ha-sentinel-core-v21"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  SENTINEL ENGINE v5.0 — IAM Provisioning                ║"
echo "║  Project: ${PROJECT_ID}                              ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ─────────────────────────────────────────────────────
#  SERVICE ACCOUNT 1: sentinel-etl-sa
#  Used by: Cloud Run Job (ETL pipeline)
#  Roles:
#    - roles/bigquery.dataEditor     → INSERT/DELETE/MERGE warehouse rows
#    - roles/secretmanager.secretAccessor → Read API keys at runtime
# ─────────────────────────────────────────────────────

ETL_SA="sentinel-etl-sa"
ETL_SA_EMAIL="${ETL_SA}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "[1/6] Creating service account: ${ETL_SA}..."
gcloud iam service-accounts create "${ETL_SA}" \
  --display-name="Sentinel ETL Pipeline" \
  --description="Least-privilege SA for the Sentinel ETL Cloud Run Job. Writes to BigQuery, reads secrets." \
  --project="${PROJECT_ID}" \
  2>/dev/null || echo "  Service account already exists."

echo "[2/6] Binding roles/bigquery.dataEditor to ${ETL_SA}..."
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${ETL_SA_EMAIL}" \
  --role="roles/bigquery.dataEditor" \
  --condition=None \
  --quiet

echo "[3/6] Binding roles/secretmanager.secretAccessor to ${ETL_SA}..."
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${ETL_SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor" \
  --condition=None \
  --quiet

# ─────────────────────────────────────────────────────
#  SERVICE ACCOUNT 2: sentinel-inference-sa
#  Used by: Cloud Function (Inference endpoint)
#  Roles:
#    - roles/bigquery.dataViewer → Read-only VECTOR_SEARCH queries
#    - roles/aiplatform.user     → Vertex AI embedding + GenAI calls
#    - roles/secretmanager.secretAccessor → Read secrets at boot (Boot Guard)
# ─────────────────────────────────────────────────────

INFERENCE_SA="sentinel-inference-sa"
INFERENCE_SA_EMAIL="${INFERENCE_SA}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "[4/6] Creating service account: ${INFERENCE_SA}..."
gcloud iam service-accounts create "${INFERENCE_SA}" \
  --display-name="Sentinel Inference Function" \
  --description="Least-privilege SA for the Sentinel Cloud Function. Reads BigQuery, calls Vertex AI." \
  --project="${PROJECT_ID}" \
  2>/dev/null || echo "  Service account already exists."

echo "[5/6] Binding roles/bigquery.dataViewer to ${INFERENCE_SA}..."
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${INFERENCE_SA_EMAIL}" \
  --role="roles/bigquery.dataViewer" \
  --condition=None \
  --quiet

echo "[6/6] Binding roles/aiplatform.user to ${INFERENCE_SA}..."
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${INFERENCE_SA_EMAIL}" \
  --role="roles/aiplatform.user" \
  --condition=None \
  --quiet

echo "[7/7] Binding roles/secretmanager.secretAccessor to ${INFERENCE_SA}..."
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:${INFERENCE_SA_EMAIL}" \
  --role="roles/secretmanager.secretAccessor" \
  --condition=None \
  --quiet

# ─────────────────────────────────────────────────────
#  VERIFICATION
# ─────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  IAM Provisioning Complete"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "  sentinel-etl-sa:"
echo "    ✓ roles/bigquery.dataEditor"
echo "    ✓ roles/secretmanager.secretAccessor"
echo ""
echo "  sentinel-inference-sa:"
echo "    ✓ roles/bigquery.dataViewer"
echo "    ✓ roles/aiplatform.user"
echo ""
echo "  To verify:"
echo "    gcloud projects get-iam-policy ${PROJECT_ID} --flatten='bindings[].members' \\"
echo "      --filter='bindings.members:sentinel' --format='table(bindings.role, bindings.members)'"
echo ""
