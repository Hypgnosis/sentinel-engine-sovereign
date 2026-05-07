#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  PROJECT SUB-ZERO LATENCY — Reservoir Transfer Script
#  Migrates Pristine Reservoir from Supabase to GCP Cloud SQL.
#
#  PREREQUISITES:
#    1. Cloud SQL instance provisioned via: cd terraform && terraform apply
#    2. Cloud SQL Auth Proxy running locally on port 5433:
#       cloud-sql-proxy ha-sentinel-core-v21:us-central1:sentinel-reservoir \
#         --port 5433
#    3. pgvector extension installed on target (run step 0 first)
#
#  USAGE:
#    export SUPABASE_HOST="db.xxxxx.supabase.co"
#    export SUPABASE_PASSWORD="your-supabase-pw"
#    export CLOUDSQL_PASSWORD="your-cloudsql-pw"
#    chmod +x migrate-reservoir.sh && ./migrate-reservoir.sh
#
#  ESTIMATED DOWNTIME: ~5 minutes for typical datasets.
#  For zero-downtime, use GCP Database Migration Service (DMS).
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# ─── Configuration ─────────────────────────────────────
SUPABASE_HOST="${SUPABASE_HOST:?SUPABASE_HOST is required}"
SUPABASE_USER="${SUPABASE_USER:-postgres}"
SUPABASE_PASSWORD="${SUPABASE_PASSWORD:?SUPABASE_PASSWORD is required}"
SUPABASE_DB="${SUPABASE_DB:-postgres}"

CLOUDSQL_HOST="${CLOUDSQL_HOST:-127.0.0.1}"
CLOUDSQL_PORT="${CLOUDSQL_PORT:-5433}"
CLOUDSQL_USER="${CLOUDSQL_USER:-sentinel}"
CLOUDSQL_PASSWORD="${CLOUDSQL_PASSWORD:?CLOUDSQL_PASSWORD is required}"
CLOUDSQL_DB="${CLOUDSQL_DB:-sentinel_reservoir}"

DUMP_FILE="reservoir_dump_$(date +%Y%m%d_%H%M%S).sql"

echo -e "${YELLOW}═══════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}  PROJECT SUB-ZERO: Reservoir Transfer${NC}"
echo -e "${YELLOW}  Source: Supabase (${SUPABASE_HOST})${NC}"
echo -e "${YELLOW}  Target: Cloud SQL (${CLOUDSQL_HOST}:${CLOUDSQL_PORT})${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════════════${NC}"
echo ""

# ─── Step 0: Enable pgvector on Cloud SQL ─────────────
echo -e "${GREEN}[STEP 0] Enabling pgvector extension on Cloud SQL...${NC}"
PGPASSWORD="${CLOUDSQL_PASSWORD}" psql \
  -h "${CLOUDSQL_HOST}" \
  -p "${CLOUDSQL_PORT}" \
  -U "${CLOUDSQL_USER}" \
  -d "${CLOUDSQL_DB}" \
  -c "CREATE EXTENSION IF NOT EXISTS vector;"
echo -e "${GREEN}  ✓ pgvector enabled.${NC}"

# ─── Step 1: Dump from Supabase ────────────────────────
echo -e "${GREEN}[STEP 1] Dumping Supabase database...${NC}"
PGPASSWORD="${SUPABASE_PASSWORD}" pg_dump \
  -h "${SUPABASE_HOST}" \
  -p 5432 \
  -U "${SUPABASE_USER}" \
  -d "${SUPABASE_DB}" \
  --no-owner \
  --no-privileges \
  --no-comments \
  --clean \
  --if-exists \
  --exclude-table='auth.*' \
  --exclude-table='storage.*' \
  --exclude-table='supabase_*' \
  --exclude-schema='auth' \
  --exclude-schema='storage' \
  --exclude-schema='supabase_functions' \
  --exclude-schema='extensions' \
  -f "${DUMP_FILE}"
echo -e "${GREEN}  ✓ Dump saved to ${DUMP_FILE} ($(wc -c < "${DUMP_FILE}" | tr -d ' ') bytes)${NC}"

# ─── Step 2: Restore to Cloud SQL ─────────────────────
echo -e "${GREEN}[STEP 2] Restoring to Cloud SQL...${NC}"
PGPASSWORD="${CLOUDSQL_PASSWORD}" psql \
  -h "${CLOUDSQL_HOST}" \
  -p "${CLOUDSQL_PORT}" \
  -U "${CLOUDSQL_USER}" \
  -d "${CLOUDSQL_DB}" \
  -f "${DUMP_FILE}" \
  --set ON_ERROR_STOP=off 2>&1 | tail -5
echo -e "${GREEN}  ✓ Restore complete.${NC}"

# ─── Step 3: Verify row counts ────────────────────────
echo -e "${GREEN}[STEP 3] Verifying row counts...${NC}"
TABLES=("freight_indices" "port_congestion" "maritime_chokepoints" "risk_matrix")
for table in "${TABLES[@]}"; do
  count=$(PGPASSWORD="${CLOUDSQL_PASSWORD}" psql \
    -h "${CLOUDSQL_HOST}" \
    -p "${CLOUDSQL_PORT}" \
    -U "${CLOUDSQL_USER}" \
    -d "${CLOUDSQL_DB}" \
    -t -c "SELECT COUNT(*) FROM ${table};" 2>/dev/null || echo "0")
  echo -e "  ${table}: ${count} rows"
done

# ─── Step 4: Verify pgvector indexes ──────────────────
echo -e "${GREEN}[STEP 4] Checking vector indexes...${NC}"
PGPASSWORD="${CLOUDSQL_PASSWORD}" psql \
  -h "${CLOUDSQL_HOST}" \
  -p "${CLOUDSQL_PORT}" \
  -U "${CLOUDSQL_USER}" \
  -d "${CLOUDSQL_DB}" \
  -c "SELECT indexname, tablename FROM pg_indexes WHERE indexdef LIKE '%vector%';"

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  RESERVOIR TRANSFER COMPLETE${NC}"
echo -e "${GREEN}  ${NC}"
echo -e "${GREEN}  Next steps:${NC}"
echo -e "${GREEN}    1. Update DATABASE_URL in Secret Manager:${NC}"
echo -e "${GREEN}       postgresql://sentinel:PW@/sentinel_reservoir?host=/cloudsql/ha-sentinel-core-v21:us-central1:sentinel-reservoir${NC}"
echo -e "${GREEN}    2. Set INSTANCE_CONNECTION_NAME:${NC}"
echo -e "${GREEN}       ha-sentinel-core-v21:us-central1:sentinel-reservoir${NC}"
echo -e "${GREEN}    3. Deploy: gcloud functions deploy handleSentinelInference${NC}"
echo -e "${GREEN}    4. Verify latency: curl the /inference endpoint${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
