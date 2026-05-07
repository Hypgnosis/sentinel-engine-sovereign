# 🚨 LICENSE GATE: SOVEREIGN BOUNDARY 🚨

> [!IMPORTANT]
> **READ BEFORE PROCEEDING**: This repository contains the **Sentinel Engine: Sovereign Reference Architecture**. It is a production-grade, physically enforced implementation of the Sovereign Intelligence protocols.
> 
> **THE BIFURCATED REALITY**: This architecture is split between an **Asynchronous Control Plane** (Governance Hub) and a **Deterministic Data Plane** (Sovereign Guard). This separation ensures that governance is an accelerant, not a bottleneck.
> 
> By accessing this repository, you acknowledge that this is a Reference Architecture licensed under the **GNU AGPL v3.0**.

---

# Sentinel Engine v5.5.0-Sovereign

**Absolute Governance Architecture for Industrial AI & Autonomous Systems.**

| Component | Specification |
|---|---|
| **Version** | `v5.5.0-Sovereign` |
| **Governance** | Arbiter Kernel (AGS v0.1.0 Compliant) |
| **Data Plane** | Sovereign Guard (Go Sidecar) |
| **Control Plane** | Governance Hub (Node.js 22 / GCP) |
| **Latency** | < 0.177ms (Arbitration Hot-Path) |
| **Security** | Asymmetric PKI (ECDSA P-256 / PQ-Lattice) |
| **Integrity** | Write-Ahead Log (WAL) with `fsync()` |

---

## 🏗️ Architectural Bifurcation: The "Body" and the "Soul"

Sentinel Engine V5.5 ("Sovereign Absolute") is built on the principle of **Physical Sovereignty**. We do not rely on cloud latency for real-time arbitration.

### 1. Data Plane: The Sovereign Guard (Go Sidecar)
**Determinism: < 0.177ms | Language: Go | Mode: Local IPC (UDS)**

The Sovereign Guard co-locates with the AI Agent on the same node. It serves as the **Physical Execution Boundary**.
- **Real-Time Arbitration**: All tool calls are intercepted via Unix Domain Sockets (UDS), eliminating the 50ms-200ms cloud round-trip.
- **WAL Persistence**: Every decision is `fsync`'d to a local Write-Ahead Log BEFORE the verdict is returned, closing the "Dirty Read Gap."
- **Offline Continuity**: In the event of a total network blackout (e.g., CFE Energy Grid failure), the Guard continues to arbitrate tool calls using local policy snapshots.

### 2. Control Plane: The Governance Hub (Cloud)
**Role: Governance & Evidence Locker | Language: Node.js 22 | Mode: Async Sync**

The Governance Hub handles high-level orchestration and non-repudiable auditing.
- **Asymmetric Sealing**: Every decision is cryptographically sealed using ECDSA P-256 or Post-Quantum Lattice signatures.
- **Evidence Locker**: Background synchronization of WAL entries into BigQuery and PostgreSQL for long-term auditability.
- **Cognitive Dashboard**: HITL (Human-in-the-Loop) oversight and telemetry visualization.

---

## ⚡ The CFE Grid Seam: Edge Arbitration

For critical infrastructure like the **CFE Energy Grid**, Sentinel enforces **Edge Arbitration**. 
When a "Riesgo de Apagón" (Blackout Risk) trigger is detected, the arbitration does NOT wait for a cloud handshake. It is resolved within the **0.177ms boundary** of the Go Sidecar, ensuring that safety-critical despacho protocols are executed with deterministic speed, even in sub-optimal network conditions.

---

## 🛠️ Technical Stack

| Layer | Technology | Role |
|---|---|---|
| **Data Plane** | Go 1.22+ | Deterministic Sidecar & WAL Manager |
| **Control Plane** | Node.js 22 (GCP Gen2) | Governance Hub & Shard Routing |
| **Security** | ECDSA P-256 / CRYSTALS-Dilithium | Non-Repudiable Evidence Sealing |
| **Persistence** | PostgreSQL (pgvector) | Sovereign Audit Log (Primary) |
| **Warehouse** | BigQuery | Data Moat (Long-term Auditing) |
| **IPC** | Unix Domain Sockets (UDS) | < 0.177ms Arbitration Hot-Path |

---

## 🚀 Deployment

```bash
# 1. Initialize the Sovereign Guard (Sidecar)
cd sovereign-guard && go build -o sentinel-guard .
./sentinel-guard

# 2. Deploy the Governance Hub (Proxy)
cd functions && npm run deploy

# 3. Verify the Seams
bash tests/run_crucible_local.sh
```

---

*Built by **High ArchyTech Solutions** — Moving the world's data with Sovereign Integrity.*
