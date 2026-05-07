#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  SENTINEL ENGINE v4.0 — BigQuery Provisioning
#  Runs the canonical schemas.sql DDL to provision the warehouse.
#
#  Prerequisites:
#    - gcloud CLI authenticated with BigQuery Admin role
#    - BigQuery API enabled on the target project
#
#  Usage:
#    export PROJECT_ID=ha-sentinel-core-prod
#    chmod +x setup.sh && ./setup.sh
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-ha-sentinel-core-prod}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  SENTINEL ENGINE v4.0 — BigQuery Warehouse Setup        ║"
echo "║  Project: ${PROJECT_ID}                                 ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── Enable Required APIs ──
echo "[1/2] Enabling BigQuery API..."
gcloud services enable bigquery.googleapis.com --project="${PROJECT_ID}" 2>/dev/null || true

# ── Execute Canonical DDL ──
echo "[2/2] Executing schemas.sql..."
bq --project_id="${PROJECT_ID}" query \
  --use_legacy_sql=false \
  --location=US \
  < "${SCRIPT_DIR}/schemas.sql"

echo ""
echo "[SENTINEL] Warehouse provisioned."
echo "  Dataset:  sentinel_warehouse"
echo "  Tables:   freight_indices, port_congestion, maritime_chokepoints, risk_matrix"
echo "  Vectors:  VECTOR<FLOAT64>(768) — text-embedding-004 compatible"
echo "  Dedup:    entity_hash (SHA-256)"
echo ""
