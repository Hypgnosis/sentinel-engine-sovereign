#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  SENTINEL ENGINE v4.1 — Energy Dataset Provisioning (CFE)
#  Creates the sentinel_warehouse_energy dataset and executes
#  the energy-specific DDL schema.
#
#  Prerequisites:
#    - gcloud CLI authenticated with BigQuery Admin role
#    - BigQuery API enabled on the target project
#
#  Usage:
#    export PROJECT_ID=ha-sentinel-core-v21
#    chmod +x setup-energy.sh && ./setup-energy.sh
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-ha-sentinel-core-v21}"
DATASET_ID="sentinel_warehouse_energy"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  SENTINEL ENGINE v4.1 — Energy Dataset Setup (CFE)      ║"
echo "║  Project: ${PROJECT_ID}                                 ║"
echo "║  Dataset: ${DATASET_ID}                                 ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── Enable Required APIs ──
echo "[1/3] Enabling BigQuery API..."
gcloud services enable bigquery.googleapis.com --project="${PROJECT_ID}" 2>/dev/null || true

# ── Create Dataset (if not exists) ──
echo "[2/3] Creating dataset ${DATASET_ID}..."
bq --project_id="${PROJECT_ID}" mk \
  --dataset \
  --location=US \
  --description="Sentinel Engine — Energy & Grid Resiliency (CFE)" \
  "${PROJECT_ID}:${DATASET_ID}" 2>/dev/null || echo "  Dataset already exists — skipping."

# ── Execute Energy DDL ──
echo "[3/3] Executing schemas_energy.sql..."
bq --project_id="${PROJECT_ID}" query \
  --use_legacy_sql=false \
  --location=US \
  < "${SCRIPT_DIR}/schemas_energy.sql"

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  [SENTINEL] Energy warehouse provisioned.               ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Dataset:  sentinel_warehouse_energy                    ║"
echo "║  Tables:   grid_telemetry, asset_health, weather_impact ║"
echo "║  Vectors:  VECTOR<FLOAT64>(768) — text-embedding-004    ║"
echo "║  Dedup:    entity_hash (SHA-256)                        ║"
echo "║  RLS:      tenant_id row-level filtering                ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. Seed demo data:   cd instances/energy-cfe && node seed-energy.js"
echo "  2. Deploy function:  gcloud functions deploy sentinelInference \\"
echo "     --set-env-vars='ACTIVE_INSTANCE=energy-cfe,BQ_DATASET=sentinel_warehouse_energy'"
echo ""
