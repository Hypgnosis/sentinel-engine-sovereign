#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
#  SENTINEL ENGINE V5.5.0 — SLO Alert Provisioning
#  Project: ha-sentinel-core-v21
#
#  Creates three Cloud Monitoring alert policies:
#    1. P95 Latency  > 8,000ms  (Tier-1 Enterprise SLO)
#    2. Error Rate   > 1%       (5xx responses in any 5-min window)
#    3. Availability < 99.5%    (rolling 24h window)
#
#  Usage:
#    bash infra/slo-alerts.sh
#
#  Prerequisites:
#    gcloud auth login
#    gcloud config set project ha-sentinel-core-v21
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

PROJECT_ID="ha-sentinel-core-v21"
FUNCTION_NAME="sentinelInference"
REGION="us-central1"
# Replace with a real notification channel ID from your project.
# Run: gcloud alpha monitoring channels list --project=$PROJECT_ID
NOTIFICATION_CHANNEL="${SENTINEL_ALERT_CHANNEL:-}"

echo "═══════════════════════════════════════════════════════"
echo " Sentinel SLO Alert Provisioning"
echo " Project : $PROJECT_ID"
echo " Function: $FUNCTION_NAME"
echo "═══════════════════════════════════════════════════════"

# ── Helper ────────────────────────────────────────────────────────────
create_alert() {
  local name="$1"
  local json_file="$2"
  echo ""
  echo "▶ Creating alert: $name"
  gcloud alpha monitoring policies create \
    --policy-from-file="$json_file" \
    --project="$PROJECT_ID"
  echo "✅ $name created."
}

# ── 1. P95 LATENCY > 8 seconds ────────────────────────────────────────
cat > /tmp/slo-latency.json <<EOF
{
  "displayName": "Sentinel | P95 Latency > 8s [SLO BREACH]",
  "documentation": {
    "content": "The 95th-percentile request latency for sentinelInference has exceeded 8,000ms. Tier-1 enterprise SLA is 8s P95. Investigate Cloud SQL latency, BQ VECTOR_SEARCH cold start, or LLM generation timeout.\n\nRunbook: https://github.com/Hypgnosis/Sentinel-Engine/blob/main/docs/runbooks/latency.md",
    "mimeType": "text/markdown"
  },
  "conditions": [
    {
      "displayName": "P95 response latency > 8000ms",
      "conditionThreshold": {
        "filter": "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"sentinelinference\" AND metric.type = \"run.googleapis.com/request_latencies\"",
        "aggregations": [
          {
            "alignmentPeriod": "300s",
            "perSeriesAligner": "ALIGN_PERCENTILE_95",
            "crossSeriesReducer": "REDUCE_MAX",
            "groupByFields": ["resource.labels.service_name"]
          }
        ],
        "comparison": "COMPARISON_GT",
        "thresholdValue": 8000,
        "duration": "0s",
        "trigger": { "count": 1 }
      }
    }
  ],
  "alertStrategy": {
    "autoClose": "1800s",
    "notificationRateLimit": { "period": "300s" }
  },
  "combiner": "OR",
  "enabled": true,
  "notificationChannels": [$([ -n "$NOTIFICATION_CHANNEL" ] && echo "\"$NOTIFICATION_CHANNEL\"" || echo "")]
}
EOF
create_alert "P95 Latency SLO" /tmp/slo-latency.json

# ── 2. ERROR RATE > 1% ────────────────────────────────────────────────
cat > /tmp/slo-error-rate.json <<EOF
{
  "displayName": "Sentinel | 5xx Error Rate > 1% [SLO BREACH]",
  "documentation": {
    "content": "5xx responses from sentinelInference have exceeded 1% of traffic in a 5-minute window. Likely causes: DB connection pool exhaustion, Secret Manager timeouts, or LLM quota exceeded.\n\nRunbook: https://github.com/Hypgnosis/Sentinel-Engine/blob/main/docs/runbooks/error-rate.md",
    "mimeType": "text/markdown"
  },
  "conditions": [
    {
      "displayName": "5xx error rate > 1%",
      "conditionThreshold": {
        "filter": "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"sentinelinference\" AND metric.type = \"run.googleapis.com/request_count\" AND metric.labels.response_code_class = \"5xx\"",
        "aggregations": [
          {
            "alignmentPeriod": "300s",
            "perSeriesAligner": "ALIGN_RATE",
            "crossSeriesReducer": "REDUCE_SUM",
            "groupByFields": ["resource.labels.service_name", "metric.labels.response_code_class"]
          }
        ],
        "denominatorFilter": "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"sentinelinference\" AND metric.type = \"run.googleapis.com/request_count\"",
        "denominatorAggregations": [
          {
            "alignmentPeriod": "300s",
            "perSeriesAligner": "ALIGN_RATE",
            "crossSeriesReducer": "REDUCE_SUM",
            "groupByFields": ["resource.labels.service_name"]
          }
        ],
        "comparison": "COMPARISON_GT",
        "thresholdValue": 0.01,
        "duration": "0s",
        "trigger": { "count": 1 }
      }
    }
  ],
  "alertStrategy": {
    "autoClose": "1800s",
    "notificationRateLimit": { "period": "300s" }
  },
  "combiner": "OR",
  "enabled": true,
  "notificationChannels": [$([ -n "$NOTIFICATION_CHANNEL" ] && echo "\"$NOTIFICATION_CHANNEL\"" || echo "")]
}
EOF
create_alert "Error Rate SLO" /tmp/slo-error-rate.json

# ── 3. EVIDENCE LOCKER WRITE FAILURE ──────────────────────────────────
# Log-based alert: fires when [EVIDENCE_WRITE_FAILURE] appears in logs.
# This is a zero-tolerance policy — one failure is one too many.
cat > /tmp/slo-evidence-locker.json <<EOF
{
  "displayName": "Sentinel | Evidence Locker Write Failure [CRITICAL]",
  "documentation": {
    "content": "An EVIDENCE_WRITE_FAILURE was detected in the sentinelInference logs. The audit trail is broken. A governance decision was made but NOT recorded in the Evidence Locker. This is a KPMG Principle 4.4 violation.\n\nRunbook: https://github.com/Hypgnosis/Sentinel-Engine/blob/main/docs/runbooks/evidence-locker.md",
    "mimeType": "text/markdown"
  },
  "conditions": [
    {
      "displayName": "Evidence Locker write failure detected",
      "conditionMatchedLog": {
        "filter": "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"sentinelinference\" AND jsonPayload.eventType=\"EVIDENCE_WRITE_FAILURE\""
      }
    }
  ],
  "alertStrategy": {
    "autoClose": "86400s",
    "notificationRateLimit": { "period": "60s" }
  },
  "combiner": "OR",
  "enabled": true,
  "notificationChannels": [$([ -n "$NOTIFICATION_CHANNEL" ] && echo "\"$NOTIFICATION_CHANNEL\"" || echo "")]
}
EOF
create_alert "Evidence Locker Failure" /tmp/slo-evidence-locker.json

# ── 4. BOOT GUARD FAILURE (Secret Missing) ────────────────────────────
cat > /tmp/slo-boot-guard.json <<EOF
{
  "displayName": "Sentinel | Boot Guard Secret Missing [CRITICAL]",
  "documentation": {
    "content": "A FATAL_SECURITY_BOOT_FAILURE was logged. A required secret was missing at container startup. The instance is not serving traffic correctly. Check Secret Manager bindings and service account IAM roles.\n\nRunbook: https://github.com/Hypgnosis/Sentinel-Engine/blob/main/docs/runbooks/boot-guard.md",
    "mimeType": "text/markdown"
  },
  "conditions": [
    {
      "displayName": "Boot guard secret failure",
      "conditionMatchedLog": {
        "filter": "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"sentinelinference\" AND textPayload=~\"FATAL_SECURITY_BOOT_FAILURE\""
      }
    }
  ],
  "alertStrategy": {
    "autoClose": "3600s",
    "notificationRateLimit": { "period": "60s" }
  },
  "combiner": "OR",
  "enabled": true,
  "notificationChannels": [$([ -n "$NOTIFICATION_CHANNEL" ] && echo "\"$NOTIFICATION_CHANNEL\"" || echo "")]
}
EOF
create_alert "Boot Guard Failure" /tmp/slo-boot-guard.json

echo ""
echo "═══════════════════════════════════════════════════════"
echo " ✅ All 4 alert policies provisioned."
echo ""
echo " SLO Targets:"
echo "   P95 Latency  : ≤ 8,000ms"
echo "   Error Rate   : ≤ 1% (5xx)"
echo "   Evidence Locker : Zero write failures"
echo "   Boot Guard   : Zero secret-missing failures"
echo ""
echo " Next: Set SENTINEL_ALERT_CHANNEL env var to wire alerts"
echo " to email/PagerDuty/Slack before pilot go-live."
echo "═══════════════════════════════════════════════════════"
