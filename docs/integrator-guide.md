# Sentinel Engine v5.5.0-Sovereign — Integrator Guide

> **Version**: 5.5.0 (Sovereign Absolute — Production)  
> **Project**: `ha-sentinel-core-v21`  
> **Author**: High ArchyTech Solutions  
> **Last Updated**: 2026-04-22  

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Authentication](#authentication)
3. [API Reference (OpenAPI 3.0)](#api-reference)
4. [Integration Examples](#integration-examples)
5. [Multi-Tenancy & Data Sovereignty](#multi-tenancy)
6. [Error Codes](#error-codes)
7. [SLOs & Monitoring](#slos--monitoring)
8. [Operational Runbooks](#operational-runbooks)
9. [Security Model](#security-model)

---

## Architecture Overview

```
┌───────────────────────────────────────────────────────────────────┐
│                     SENTINEL ENGINE v5.5                          │
│           Sovereign Absolute Architecture (GCP-Native)            │
├──────────────────┬────────────────────┬───────────────────────────┤
│   INFERENCE      │      ETL           │     INFRASTRUCTURE       │
│                  │                    │                           │
│ Cloud Function   │ Cloud Run Job      │ Terraform (IaC)          │
│ Gemini 2.5 Flash │ Freightos/Xeneta   │ Secret Manager           │
│ Arbiter Kernel   │ Circuit Breaker    │ IAM Service Accounts     │
│ raceToData RAG   │ SHA-256 Dedup      │ Cloud Monitoring + SLOs  │
│ Tenant-scoped    │ Tenant-stamped     │ Row-Level Security       │
│ Postgres + BQ    │                    │ Asymmetric Boot PKI      │
└──────────────────┴────────────────────┴───────────────────────────┘
         │                    │                       │
         ▼                    ▼                       ▼
┌──────────────────────────────────────────────────────────────────┐
│   Postgres (Pristine Reservoir) + BigQuery (sentinel_warehouse)  │
│  ┌──────────────┐ ┌──────────────┐ ┌─────────────┐ ┌──────────┐│
│  │freight_indices│ │port_congestion│ │chokepoints  │ │risk_matrix││
│  │+ tenant_id   │ │+ tenant_id   │ │+ tenant_id  │ │+ tenant_id││
│  │+ embedding   │ │+ embedding   │ │+ embedding  │ │+ embedding││
│  └──────────────┘ └──────────────┘ └─────────────┘ └──────────┘│
└──────────────────────────────────────────────────────────────────┘
```

---

## Authentication

All API calls require a **Firebase ID Token** with a custom `tenant_id` claim.

### Obtaining a Token

```javascript
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';

const auth = getAuth();
const cred = await signInWithEmailAndPassword(auth, email, password);
const token = await cred.user.getIdToken();
```

### Tenant Provisioning

Tenants are provisioned server-side using Firebase Admin SDK:

```javascript
import admin from 'firebase-admin';
await admin.auth().setCustomUserClaims(uid, { tenant_id: 'acme-logistics' });
```

### Zero-Trust PEP Gate

The Policy Enforcement Point (PEP Gate) is the first layer of defense and is **non-negotiable**. It enforces the following rules on every inbound request:

| Rule | Enforcement |
|------|-------------|
| Bearer token must be present | `401 SENTINEL_AUTH_MISSING` |
| Token must be a valid, non-expired Firebase JWT | `401 SENTINEL_AUTH_INVALID` |
| Decoded token must contain a `tenant_id` custom claim | `403 SENTINEL_TENANT_REQUIRED` |
| Anonymous authentication fallback | **Permanently deleted in V5.5** |

The anonymous fallback that existed in pre-V5.5 builds has been permanently removed. There is no guest mode, no default tenant, and no `uid`-based fallback. If the `tenant_id` claim is absent, the request is dropped before it reaches the inference layer — no exceptions.

> [!IMPORTANT]
> **PROVISIONING REQUIREMENT**: Tenants must be provisioned before users can authenticate. An unprovisionied user with a valid Firebase token will receive `403`. Run `npm run provision-tenant` with the appropriate configuration to onboard new tenants.

> **CRITICAL**: Users without a `tenant_id` claim receive `403 SENTINEL_TENANT_REQUIRED`.

---

## API Reference

### OpenAPI 3.0 Specification

```yaml
openapi: "3.0.3"
info:
  title: Sentinel Engine — Sovereign Intelligence API
  version: "5.5.0"
  description: |
    Enterprise logistics intelligence API powered by BigQuery VECTOR_SEARCH RAG
    and Gemini 2.5 Flash structured inference. Multi-tenant, zero-trust.
  contact:
    name: High ArchyTech Solutions
    email: engineering@high-archy.tech
  license:
    name: Proprietary
servers:
  - url: https://us-central1-ha-sentinel-core-v21.cloudfunctions.net
    description: Production (GCP Cloud Functions Gen2)
  - url: http://localhost:8080
    description: Local development

paths:
  /sentinelInference:
    post:
      operationId: sentinelInference
      summary: Execute sovereign logistics intelligence inference
      description: |
        Accepts a natural language query about logistics, freight rates,
        port congestion, chokepoints, or supply chain risks. Returns
        structured JSON with narrative analysis, extracted KPIs, confidence
        scores, and data provenance.
      security:
        - bearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [query]
              properties:
                query:
                  type: string
                  description: Natural language logistics intelligence query
                  example: "What is the current Shanghai-Rotterdam container rate?"
                  minLength: 1
                  maxLength: 4000
      responses:
        "200":
          description: Successful inference
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/InferenceResponse"
        "400":
          description: Bad Request — empty or invalid query
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "401":
          description: Unauthorized — missing or invalid Bearer token
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "403":
          description: Forbidden — no tenant_id claim on token
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "405":
          description: Method Not Allowed — only POST accepted
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "429":
          description: Too Many Requests — rate limit exceeded
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "500":
          description: Internal infrastructure failure
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
        "503":
          description: No data available — ETL pipeline may need to run
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ErrorResponse"
    options:
      summary: CORS preflight
      responses:
        "204":
          description: No Content (CORS preflight OK)

components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: Firebase ID Token (JWT)
      description: Firebase ID Token with `tenant_id` custom claim

  schemas:
    InferenceResponse:
      type: object
      required: [status, model, timestamp, data, infrastructure, requestId]
      properties:
        status:
          type: string
          enum: [SUCCESS]
        model:
          type: string
          example: "gemini-2.5-flash"
        timestamp:
          type: string
          format: date-time
        requestId:
          type: string
          example: "SEN-1712234567890-A1B2C3"
        infrastructure:
          type: string
          example: "Sentinel v5.5 — GCP_BIGQUERY_VECTOR_RAG"
        data:
          $ref: "#/components/schemas/IntelligencePayload"

    IntelligencePayload:
      type: object
      required: [narrative, confidence, sources, dataAuthority]
      properties:
        narrative:
          type: string
          description: Markdown-formatted analysis with KPIs and recommendations
        metrics:
          type: array
          items:
            $ref: "#/components/schemas/Metric"
        confidence:
          type: number
          format: float
          minimum: 0.0
          maximum: 1.0
          description: Overall confidence score
        sources:
          type: array
          items:
            type: string
          description: Data sources used
        dataAuthority:
          type: string
          enum: [GCP_BIGQUERY_VECTOR_RAG, FIRESTORE_LEGACY]

    Metric:
      type: object
      required: [label, value]
      properties:
        label:
          type: string
          example: "Shanghai-Rotterdam Rate"
        value:
          type: string
          example: "$2,340/FEU"
        trend:
          type: string
          enum: [up, down, stable]
        confidence:
          type: number
          format: float
          minimum: 0.0
          maximum: 1.0

    ErrorResponse:
      type: object
      required: [error, code, message, requestId]
      properties:
        error:
          type: string
        code:
          type: string
        message:
          type: string
        detail:
          type: string
        requestId:
          type: string
```

---

## Integration Examples

### cURL

```bash
curl -X POST \
  https://us-central1-ha-sentinel-core-v21.cloudfunctions.net/sentinelInference \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${FIREBASE_ID_TOKEN}" \
  -d '{"query": "What is the current Shanghai-Rotterdam container rate?"}'
```

### JavaScript (Node.js)

```javascript
const response = await fetch(
  'https://us-central1-ha-sentinel-core-v21.cloudfunctions.net/sentinelInference',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`,
    },
    body: JSON.stringify({
      query: 'Summarize top 5 supply chain risks for Q2 2026',
    }),
  }
);

const { data } = await response.json();
console.log(data.narrative);     // Markdown analysis
console.log(data.metrics);       // Extracted KPIs
console.log(data.confidence);    // 0.0–1.0
console.log(data.dataAuthority); // GCP_BIGQUERY_VECTOR_RAG
```

### Python

```python
import requests

resp = requests.post(
    "https://us-central1-ha-sentinel-core-v21.cloudfunctions.net/sentinelInference",
    headers={
        "Authorization": f"Bearer {firebase_id_token}",
        "Content-Type": "application/json",
    },
    json={"query": "Port congestion levels in Southeast Asia"},
)

data = resp.json()["data"]
print(data["narrative"])
```

---

## Multi-Tenancy

### Row-Level Security Model

Every row in BigQuery includes a `tenant_id` column. Access is enforced at three layers:

| Layer | Mechanism | Enforced By |
|-------|-----------|-------------|
| **Application** | `WHERE tenant_id = @tenantId` in every SQL query | Cloud Function |
| **BigQuery RLS** | `CREATE ROW ACCESS POLICY` on each table | BigQuery DDL |
| **IAM** | Service accounts with least-privilege roles | Terraform / IAM script |

### Tenant Isolation Guarantees

1. The inference function extracts `tenant_id` exclusively from the verified JWT `tenant_id` custom claim
2. The ETL pipeline stamps every ingested row with the configured `TENANT_ID`
3. BigQuery Row Access Policies prevent cross-tenant data leakage even if application logic has bugs
4. No fallback to `uid` — unauthenticated or un-provisioned users get `403`

---

## Error Codes

| HTTP | Code | Meaning |
|------|------|---------|
| 400 | `SENTINEL_EMPTY_QUERY` | Query field is missing or empty |
| 401 | `SENTINEL_AUTH_MISSING` | No Bearer token in Authorization header |
| 401 | `SENTINEL_AUTH_INVALID` | Token expired, revoked, or malformed |
| 403 | `SENTINEL_TENANT_REQUIRED` | User lacks `tenant_id` custom claim |
| 405 | `SENTINEL_METHOD_DENIED` | Non-POST method used |
| 422 | `SCHEMA_VALIDATION_FAILED` | AI produced structurally unverifiable output (Zod gate) |
| 429 | `SENTINEL_RATE_LIMIT_EXCEEDED` | >5 requests in 10 seconds |
| 500 | `DECISION_LATENCY_ERROR` | Internal inference failure |
| 503 | `SOURCE_ALPHA_MISSING` | No data across all RAG tiers |

---

## SLOs & Monitoring

| SLO | Target | Alert Policy |
|-----|--------|-------------|
| **P95 Inference Latency** | ≤ 8,000ms | `Sentinel \| P95 Latency > 8s [SLO BREACH]` |
| **5xx Error Rate** | ≤ 1% per 5-min window | `Sentinel \| 5xx Error Rate > 1% [SLO BREACH]` |
| **Evidence Locker Write Failure** | Zero tolerance | `Sentinel \| Evidence Locker Write Failure [CRITICAL]` |
| **Boot Guard Secret Missing** | Zero tolerance | `Sentinel \| Boot Guard Secret Missing [CRITICAL]` |
| **ETL Data Staleness** | < 60 minutes | `SLO: ETL Data Staleness > 60 minutes` |
| **ETL Job Success Rate** | 100% | `Sentinel ETL — Job Failure` |

Alert policies are provisioned via `bash infra/slo-alerts.sh`. Set `SENTINEL_ALERT_CHANNEL` to wire notifications to email, PagerDuty, or Slack before running.

---

## Operational Runbooks

### 1. ETL Job Failing or Timing Out

```text
1. Check execution history:
   gcloud run jobs executions list --job=sentinel-etl --project=ha-sentinel-core-v21

2. Review structured logs:
   gcloud logging read 'resource.type="cloud_run_job" AND jsonPayload.event="ETL_PIPELINE_FAILURE"' \
     --project=ha-sentinel-core-v21 --limit=10 --format=json

3. Common causes:
   - Secret Manager access denied → check sentinel-etl-sa IAM bindings
   - BigQuery table not found → run bigquery/schemas.sql
   - Vertex AI embedding quota exhausted → check AI Platform quotas
   - Live API timeout → circuit breaker should degrade to static feed
```

### 2. LLM/Embedding Quota Exceeded

```text
1. Check Vertex AI quotas:
   gcloud ai quotas list --project=ha-sentinel-core-v21 --region=us-central1

2. If embedding quota is hit:
   - ETL will fail at the TRANSFORM stage
   - Reduce ETL cron frequency or request quota increase

3. If Gemini inference quota is hit:
   - Inference function returns 500
   - Consider rate limiting adjustments
```

### 3. BigQuery Cost Spike

```text
1. Check active queries:
   bq ls -j --project_id=ha-sentinel-core-v21 -a -n 20

2. Review VECTOR_SEARCH costs:
   - Each inference triggers 4 parallel VECTOR_SEARCH queries
   - Monitor via Cloud Console > BigQuery > Administration > Slots

3. Mitigation:
   - Reduce VECTOR_TOP_K from 15 to 10
   - Add result caching in the Cloud Function
   - Review BQ reservation pricing
```

### 4. Authentication/Authorization Failures

```text
1. User gets 401:
   - Verify token is not expired: jwt.io
   - Check Firebase Auth console for user status

2. User gets 403:
   - Verify tenant_id claim:
     firebase auth:import --list-users | grep <uid>
   - Set claim server-side:
     admin.auth().setCustomUserClaims(uid, { tenant_id: 'their-tenant' })
```

---

## Security Model

### Secrets Management

| Secret | Stored In | Consumed By |
|--------|-----------|-------------|
| `GEMINI_API_KEY` | Secret Manager | Cloud Function (inference) |
| `FREIGHTOS_API_KEY` | Secret Manager | Cloud Run Job (ETL) |
| `XENETA_API_KEY` | Secret Manager | Cloud Run Job (ETL) |

**No secrets in environment variables or source code.**

### IAM Service Accounts

| Service Account | Purpose | Roles |
|-----------------|---------|-------|
| `sentinel-etl-sa` | ETL Cloud Run Job | `bigquery.dataEditor`, `secretmanager.secretAccessor` |
| `sentinel-inference-sa` | Inference Cloud Function | `bigquery.dataViewer`, `aiplatform.user` |

### CORS Policy

Only explicitly allowlisted origins can call the API:
- `http://localhost:3000` (dev)
- `http://localhost:5173` (dev)
- `https://sentinel.high-archy.tech` (production)
- `https://sentinel-engine.netlify.app` (staging)

### V5.5 Security Architecture

#### Security-Performance Synchronization

The V5.5 security model does not introduce latency — it is synchronized with the inference pipeline. Here is why:

- **ECDSA P-256 signing** executes in < 1ms on Node.js 22 using the native `crypto` module.
- **GIN-indexed Postgres** delivers governance finding recall in < 0.177ms — faster than a single network round-trip.
- **BigQuery streaming insert** is fired after the primary response is returned to the client — zero-latency impact on P95.
- **Zod schema validation** operates on the structured JSON output, not the raw LLM stream, adding < 2ms.

The net result: the security layer adds **< 4ms** to P95 latency. The SLO budget is 8,000ms. The engine is operating with a **99.95% security overhead margin**.

#### Feature Matrix

| Feature | Description |
|---------|-------------|
| **Asymmetric Boot PKI** | `AsymmetricKmsProvider` (ECDSA P-256) is boot-guarded. Private key is accessed JIT from Secret Manager and never persisted in memory beyond the signing call. |
| **Arbiter Kernel** | Single-pass atomic inference. One Gemini call, one structured JSON verdict, zero round-trips. Eliminates the latency penalty of multi-turn verification loops. |
| **8-Secret Boot Guard** | Container fails fast (hard crash) if any of the 8 required secrets is absent at startup. No partial-boot silent failure. |
| **raceToData RAG** | Result-aware parallel RAG. The first tier to return data wins. Empty results from any tier are suppressed. The context packer assembles the winning tier's output into the 16KB window. |
| **Fail-Fast Integrity** | Zod schema violations produce typed `422 SCHEMA_VALIDATION_FAILED` with `failedModules` detail. The Arbiter never emits an unvalidated response. |
| **BigQuery Audit Sink** | Every `recordEvent()` fires a non-blocking BQ streaming insert (KPMG 4.4). ECDSA signature is preserved. BQ failure never blocks the primary response. |

---

## Cognitive Decision Support

The Sentinel Sovereign Dashboard is not a log viewer. It is a **Cognitive Decision Support** interface designed to protect supervisor attention from alert fatigue.

### The Supervisor Attention Economy

In high-throughput logistics operations, an AI governance system that surfaces every decision for human review is equivalent to no governance at all — supervisors develop "approval fatigue" and rubber-stamp decisions to clear the queue.

Sentinel solves this with **Gavel Logic**:

1. **Autonomous Resolution (≥98% of traffic)**: Decisions where the Arbiter Kernel has confidence ≥ 0.7 and the classification is `GENERAL` or `STANDARD` are resolved autonomously and streamed directly to the BQ audit sink. The supervisor never sees them.
2. **Escalation Queue (≤2% of traffic)**: Decisions where confidence < 0.5, classification is `HIGH_IMPACT` or `RESTRICTED`, or a governance finding is triggered — these surface in the HITL dashboard as action-required items.
3. **Optimistic Ingest**: The dashboard reflects new escalations via real-time state projection. There are no loading spinners; the cryptographic math computed by the backend is displayed the instant it is available.

### What the Supervisor Sees

For each escalated decision, the dashboard presents:

| Field | Description |
|-------|-------------|
| **Narrative** | The Arbiter's formatted analysis — what it found, why it escalated |
| **Confidence** | 0.0–1.0 signal with trend indicator |
| **Governance Finding** | The specific invariant that triggered escalation |
| **Data Authority** | Which RAG tier produced the context (`GCP_BIGQUERY_VECTOR_RAG` / `FIRESTORE_LEGACY`) |
| **ECDSA Signature** | Verifiable proof the decision was produced by this engine build |

The supervisor's action (approve, override, halt) is itself recorded as a signed entry in the Evidence Locker — creating a complete, non-repudiable chain of human+AI accountability.

---

### FIPS 140-2 / HSM Compliance

> **FIPS-GRADE SECURITY**: The Sentinel Engine v5.5 utilizes an **AsymmetricKmsProvider** 
> (ECDSA P-256) for non-repudiable transaction signing. This architecture is designed for 
> FIPS 140-2 Level 3 compliance when paired with a Cloud HSM. Software-based fallbacks 
> are explicitly disabled in production mode. Contact [High ArchyTech Solutions](https://high-archy.tech) 
> for HSM integration guides.

---

## Environment Bootstrap

### Prerequisites

1. GCP project `ha-sentinel-core-v21` with billing enabled
2. `gcloud` CLI authenticated
3. Terraform >= 1.5.0

### Quick Start

```bash
# 1. Enable APIs + create SAs + create secret slots
cd terraform && terraform init && terraform apply

# 2. Provision secrets (manual — one time)
echo -n "your-gemini-key" | gcloud secrets versions add GEMINI_API_KEY --data-file=- --project=ha-sentinel-core-v21
echo -n "your-freightos-key" | gcloud secrets versions add FREIGHTOS_API_KEY --data-file=- --project=ha-sentinel-core-v21
echo -n "your-xeneta-key" | gcloud secrets versions add XENETA_API_KEY --data-file=- --project=ha-sentinel-core-v21

# 3. Create BigQuery tables + RLS policies
bq query --use_legacy_sql=false --project_id=ha-sentinel-core-v21 < bigquery/schemas.sql

# 4. Deploy inference function
cd functions && npm run deploy

# 5. Deploy ETL pipeline
cd etl && gcloud run jobs deploy sentinel-etl \
  --source=. --region=us-central1 \
  --service-account=sentinel-etl-sa@ha-sentinel-core-v21.iam.gserviceaccount.com \
  --project=ha-sentinel-core-v21

# 6. Configure monitoring alerts + SLOs
chmod +x infra/alerts.sh && ./infra/alerts.sh

# 7. Run evaluation suite
SENTINEL_AUTH_TOKEN=<token> node --test tests/backend-eval.test.js
```
