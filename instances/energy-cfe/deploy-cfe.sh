#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  SENTINEL ENGINE v4.1 — Full CFE Instance Deployment
#  End-to-end provisioning: BigQuery → ETL Seed → Cloud Function
#
#  This script provisions a complete, sovereign energy instance
#  for CFE (Comisión Federal de Electricidad).
#
#  Prerequisites:
#    - gcloud CLI authenticated with adequate permissions
#    - Node.js 20+ installed
#    - BigQuery Admin, Cloud Functions Admin roles
#
#  Usage:
#    export PROJECT_ID=ha-sentinel-core-v21
#    chmod +x deploy-cfe.sh && ./deploy-cfe.sh
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-ha-sentinel-core-v21}"
INSTANCE_ID="energy-cfe"
BQ_DATASET="sentinel_warehouse_energy"
TENANT_ID="${TENANT_ID:-cfe-demo}"
REGION="${REGION:-us-central1}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  SENTINEL ENGINE v4.1 — CFE Full Deployment                ║"
echo "║  Instance: ${INSTANCE_ID}                                  ║"
echo "║  Project:  ${PROJECT_ID}                                   ║"
echo "║  Dataset:  ${BQ_DATASET}                                   ║"
echo "║  Tenant:   ${TENANT_ID}                                    ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ─────────────────────────────────────────────────────
#  PHASE 1: BigQuery Warehouse Provisioning
# ─────────────────────────────────────────────────────

echo "━━━ PHASE 1: BigQuery Warehouse ━━━"
echo ""

# Run the setup script
bash "${SCRIPT_DIR}/setup-energy.sh"

echo ""
echo "[✓] Phase 1 complete — BigQuery dataset provisioned."
echo ""

# ─────────────────────────────────────────────────────
#  PHASE 2: ETL Data Seeding
# ─────────────────────────────────────────────────────

echo "━━━ PHASE 2: ETL Data Seeding ━━━"
echo ""

cd "${ROOT_DIR}"
BQ_DATASET="${BQ_DATASET}" TENANT_ID="${TENANT_ID}" node "${SCRIPT_DIR}/seed-energy.js"

echo ""
echo "[✓] Phase 2 complete — Energy data seeded with embeddings."
echo ""

# ─────────────────────────────────────────────────────
#  PHASE 3: Cloud Function Deployment
# ─────────────────────────────────────────────────────

echo "━━━ PHASE 3: Cloud Function Deployment ━━━"
echo ""

cd "${ROOT_DIR}/functions"

gcloud functions deploy sentinelInference \
  --gen2 \
  --runtime=nodejs20 \
  --region="${REGION}" \
  --source=. \
  --entry-point=sentinelInference \
  --trigger-http \
  --allow-unauthenticated \
  --memory=1Gi \
  --timeout=120s \
  --min-instances=1 \
  --max-instances=10 \
  --set-env-vars="ACTIVE_INSTANCE=${INSTANCE_ID},BQ_DATASET=${BQ_DATASET},GCP_REGION=${REGION}" \
  --project="${PROJECT_ID}"

echo ""
echo "[✓] Phase 3 complete — Cloud Function deployed with ACTIVE_INSTANCE=${INSTANCE_ID}."
echo ""

# ─────────────────────────────────────────────────────
#  DEPLOYMENT SUMMARY
# ─────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  ⚡ CFE DEPLOYMENT COMPLETE                                ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Instance:  energy-cfe                                     ║"
echo "║  Industry:  Energy & Grid Resiliency                       ║"
echo "║  Dataset:   sentinel_warehouse_energy                      ║"
echo "║  Tables:    grid_telemetry, asset_health, weather_impact   ║"
echo "║  Language:  es-MX (Spanish Mexico)                         ║"
echo "║  TTS:       es-US-Neural2-A                                ║"
echo "║  Accent:    #FFB300 (Ámbar CFE)                            ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "To switch back to logistics:"
echo "  gcloud functions deploy sentinelInference \\"
echo "    --set-env-vars='ACTIVE_INSTANCE=logistics,BQ_DATASET=sentinel_warehouse'"
echo ""
