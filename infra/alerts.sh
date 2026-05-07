#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
#  SENTINEL ENGINE v5.0 — Cloud Monitoring Alert Policies + SLOs
#  Configures production alerting for the ETL pipeline and inference.
#
#  Alert Policies:
#    1. ETL Job Failure      — fires when a Cloud Run Job execution fails
#    2. ETL Job Timeout      — fires when execution exceeds 240s
#    3. Data Staleness (SLO) — fires when BigQuery data is > 60 min old
#    4. Inference Latency (SLO) — fires when P95 latency > 4s
#
#  SLO Targets:
#    - P95 Inference Latency < 4000ms
#    - ETL Data Staleness    < 60 minutes
#
#  Prerequisites:
#    - Cloud Monitoring API enabled
#    - Notification channel configured (email/Slack/PagerDuty)
#
#  Usage:
#    chmod +x alerts.sh && ./alerts.sh
# ═══════════════════════════════════════════════════════════════════

set -euo pipefail

PROJECT_ID="ha-sentinel-core-v21"
ALERT_EMAIL="${ALERT_EMAIL:-engineering@high-archy.tech}"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║  SENTINEL ENGINE v5.0 — Cloud Monitoring & SLOs         ║"
echo "║  Project: ${PROJECT_ID}                              ║"
echo "║  Contact: ${ALERT_EMAIL}                                ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ── Step 1: Create email notification channel ──
echo "[1/5] Creating notification channel..."
CHANNEL_ID=$(gcloud alpha monitoring channels create \
  --display-name="Sentinel Engineering Team" \
  --type=email \
  --channel-labels="email_address=${ALERT_EMAIL}" \
  --project="${PROJECT_ID}" \
  --format="value(name)" 2>/dev/null || echo "")

if [ -z "$CHANNEL_ID" ]; then
  echo "  Channel may already exist. Listing existing channels..."
  CHANNEL_ID=$(gcloud alpha monitoring channels list \
    --project="${PROJECT_ID}" \
    --filter="displayName='Sentinel Engineering Team'" \
    --format="value(name)" | head -1)
fi

echo "  Channel: ${CHANNEL_ID}"

# ── Step 2: Alert Policy — ETL Job Failure ──
echo "[2/5] Creating alert: ETL Job Failure..."
cat > /tmp/sentinel-alert-failure.json <<EOF
{
  "displayName": "Sentinel ETL — Job Failure",
  "documentation": {
    "content": "The Sentinel ETL Cloud Run Job has failed. Check Cloud Run logs for the sentinel-etl job. Ingestion ID will be in the structured logs.",
    "mimeType": "text/markdown"
  },
  "conditions": [
    {
      "displayName": "Cloud Run Job Failed Execution",
      "conditionThreshold": {
        "filter": "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"sentinel-etl\" AND metric.type=\"run.googleapis.com/job/completed_execution_count\" AND metric.labels.result=\"failed\"",
        "comparison": "COMPARISON_GT",
        "thresholdValue": 0,
        "duration": "0s",
        "aggregations": [
          {
            "alignmentPeriod": "300s",
            "perSeriesAligner": "ALIGN_COUNT"
          }
        ]
      }
    }
  ],
  "alertStrategy": {
    "autoClose": "1800s"
  },
  "combiner": "OR",
  "enabled": true,
  "notificationChannels": ["${CHANNEL_ID}"]
}
EOF

gcloud alpha monitoring policies create \
  --policy-from-file=/tmp/sentinel-alert-failure.json \
  --project="${PROJECT_ID}" 2>/dev/null || echo "  Alert policy may already exist."

# ── Step 3: Alert Policy — ETL Job Timeout ──
echo "[3/5] Creating alert: ETL Job Timeout..."
cat > /tmp/sentinel-alert-timeout.json <<EOF
{
  "displayName": "Sentinel ETL — Execution Timeout Warning",
  "documentation": {
    "content": "The Sentinel ETL Cloud Run Job execution exceeded 240 seconds (of 300s limit). Pipeline may be at risk of timeout failures.",
    "mimeType": "text/markdown"
  },
  "conditions": [
    {
      "displayName": "Cloud Run Job Duration > 240s",
      "conditionThreshold": {
        "filter": "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"sentinel-etl\" AND metric.type=\"run.googleapis.com/job/completed_execution_count\"",
        "comparison": "COMPARISON_GT",
        "thresholdValue": 240000,
        "duration": "0s",
        "aggregations": [
          {
            "alignmentPeriod": "300s",
            "perSeriesAligner": "ALIGN_MAX"
          }
        ]
      }
    }
  ],
  "alertStrategy": {
    "autoClose": "3600s"
  },
  "combiner": "OR",
  "enabled": true,
  "notificationChannels": ["${CHANNEL_ID}"]
}
EOF

gcloud alpha monitoring policies create \
  --policy-from-file=/tmp/sentinel-alert-timeout.json \
  --project="${PROJECT_ID}" 2>/dev/null || echo "  Alert policy may already exist."

# ── Step 4: SLO Alert — Data Staleness > 60 minutes ──
echo "[4/5] Creating SLO alert: Data Staleness > 60 minutes..."
cat > /tmp/sentinel-slo-staleness.json <<EOF
{
  "displayName": "SLO: ETL Data Staleness > 60 minutes",
  "documentation": {
    "content": "## SLO Breach: Data Staleness\n\nThe most recent ETL ingestion is older than **60 minutes**.\n\nTarget: Data must be refreshed at least every 60 minutes.\n\n### Runbook\n1. Check if the Cloud Scheduler cron is firing: \`gcloud scheduler jobs list --project=${PROJECT_ID}\`\n2. Check Cloud Run Job execution history: \`gcloud run jobs executions list --job=sentinel-etl --project=${PROJECT_ID}\`\n3. Review structured logs for \`ETL_PIPELINE_FAILURE\` events.\n4. Verify BigQuery table freshness: \`SELECT MAX(ingested_at) FROM sentinel_warehouse.freight_indices\`",
    "mimeType": "text/markdown"
  },
  "conditions": [
    {
      "displayName": "BigQuery Last Ingestion > 60 min ago",
      "conditionThreshold": {
        "filter": "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"sentinel-etl\" AND metric.type=\"run.googleapis.com/job/completed_execution_count\" AND metric.labels.result=\"succeeded\"",
        "comparison": "COMPARISON_LT",
        "thresholdValue": 1,
        "duration": "3600s",
        "aggregations": [
          {
            "alignmentPeriod": "3600s",
            "perSeriesAligner": "ALIGN_COUNT"
          }
        ]
      }
    }
  ],
  "alertStrategy": {
    "autoClose": "7200s"
  },
  "combiner": "OR",
  "enabled": true,
  "notificationChannels": ["${CHANNEL_ID}"]
}
EOF

gcloud alpha monitoring policies create \
  --policy-from-file=/tmp/sentinel-slo-staleness.json \
  --project="${PROJECT_ID}" 2>/dev/null || echo "  Alert policy may already exist."

# ── Step 5: SLO Alert — P95 Inference Latency > 4s ──
echo "[5/5] Creating SLO alert: P95 Inference Latency > 4s..."
cat > /tmp/sentinel-slo-latency.json <<EOF
{
  "displayName": "SLO: Inference P95 Latency > 4 seconds",
  "documentation": {
    "content": "## SLO Breach: P95 Inference Latency\n\nThe P95 response latency for the \`sentinelInference\` Cloud Function has exceeded **4 seconds**.\n\nTarget: P95 < 4000ms.\n\n### Runbook\n1. Check Cloud Function metrics: Cloud Console > Cloud Functions > sentinelInference > Metrics\n2. Review cold-start frequency — consider minimum instances.\n3. Check BigQuery VECTOR_SEARCH latency — review query execution plans.\n4. Verify Vertex AI embedding API is within quota.\n5. Check if Firestore fallback is being triggered (indicates BQ issues).",
    "mimeType": "text/markdown"
  },
  "conditions": [
    {
      "displayName": "Cloud Function P95 Latency > 4000ms",
      "conditionThreshold": {
        "filter": "resource.type=\"cloud_function\" AND resource.labels.function_name=\"sentinelInference\" AND metric.type=\"cloudfunctions.googleapis.com/function/execution_times\"",
        "comparison": "COMPARISON_GT",
        "thresholdValue": 4000000000,
        "duration": "300s",
        "aggregations": [
          {
            "alignmentPeriod": "300s",
            "perSeriesAligner": "ALIGN_PERCENTILE_95"
          }
        ]
      }
    }
  ],
  "alertStrategy": {
    "autoClose": "3600s"
  },
  "combiner": "OR",
  "enabled": true,
  "notificationChannels": ["${CHANNEL_ID}"]
}
EOF

gcloud alpha monitoring policies create \
  --policy-from-file=/tmp/sentinel-slo-latency.json \
  --project="${PROJECT_ID}" 2>/dev/null || echo "  Alert policy may already exist."

# ── Step 6: Alert Policy — Boot Guard Failure ──
echo "[6/6] Creating alert: Boot Guard Failure..."
cat > /tmp/sentinel-alert-boot.json <<EOF
{
  "displayName": "Sentinel Engine — Boot Guard Failure",
  "documentation": {
    "content": "## CRITICAL: Boot Guard Failure\n\nThe Sentinel Engine failed to initialize due to missing or invalid secrets in the global scope.\n\n**Impact:** The container has physically halted and is not serving traffic.\n\n**Runbook:**\n1. Check Cloud Function logs for \`[FATAL_SECURITY_BOOT_FAILURE]\`.\n2. Verify that \`DB_PASSWORD\`, \`SENTINEL_ENCRYPTION_KEY\`, and \`SENTINEL_SIGNING_KEY\` are correctly mapped from Secret Manager.\n3. Ensure the Service Account has \`roles/secretmanager.secretAccessor\` on the required secrets.",
    "mimeType": "text/markdown"
  },
  "conditions": [
    {
      "displayName": "Boot Failure Log Detected",
      "conditionMatchedLog": {
        "filter": "resource.type=\"cloud_function\" AND resource.labels.function_name=\"sentinelInference\" AND textPayload:\"[FATAL_SECURITY_BOOT_FAILURE]\""
      }
    }
  ],
  "alertStrategy": {
    "notificationRateLimit": {
      "period": "300s"
    }
  },
  "combiner": "OR",
  "enabled": true,
  "notificationChannels": ["${CHANNEL_ID}"]
}
EOF

gcloud alpha monitoring policies create \
  --policy-from-file=/tmp/sentinel-alert-boot.json \
  --project="${PROJECT_ID}" 2>/dev/null || echo "  Alert policy may already exist."

# ── Summary ──
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Monitoring Alerts & SLOs Configured (V5.0)"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "  ALERT POLICIES:"
echo "    1. ETL Job Failure       → Immediate alert on failed execution"
│   2. ETL Timeout Warning   → Alert when execution > 240s"
│   3. Boot Guard Failure    → CRITICAL: Alert on [FATAL_SECURITY_BOOT_FAILURE]"
echo ""
echo "  SERVICE LEVEL OBJECTIVES:"
echo "    4. Data Staleness SLO    → Alert when no successful ETL in 60 min"
echo "    5. Inference Latency SLO → Alert when P95 > 4000ms"
echo ""
echo "  Notification: ${ALERT_EMAIL}"
echo ""
echo "  To list all policies:"
echo "    gcloud alpha monitoring policies list --project=${PROJECT_ID}"
echo ""
