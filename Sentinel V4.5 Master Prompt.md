# **MASTER PROMPT: SENTINEL ENGINE V4.5 TRANSITION**

## **Role: Senior Lead Engineer (Google Antigravity Stack)**

## **Objective: Industrialize V4.1 into V4.5 "Infrastructure Preview"**

### **1\. MISSION OVERVIEW**

We are upgrading Sentinel from a BigQuery-backed "Analytical Prototype" (V4.1) to a High-Speed "Operational Core" (V4.5). The goal is to simulate the V5.0 "Sovereign Skull" using a low-cost, high-performance stack (Supabase/Neon \+ Edge Functions).

**CRITICAL REQUIREMENT:** The engine MUST maintain seamless connectivity and data-contract integrity for our primary logistics feeds: **Freightos** (rates), **Xanetta** (contracts), and **Marine Traffic** (AIS/Vessel tracking).

### **2\. CORE ARCHITECTURAL SHIFTS (V4.5)**

#### **A. Database Migration (The "Pristine Reservoir")**

* **Action:** Transition real-time RAG grounding from BigQuery to **PostgreSQL with pgvector** (Supabase/Neon).  
* **Logic:** BigQuery remains the "Long-term Data Swamp." Real-time embeddings for the current session must be stored in Postgres for sub-3s response times.  
* **Data Integrity:** Create a schema-first ingestion pipeline. Do not allow raw blobs. Every record from Freightos/Xanetta must be validated via Zod before entering the reservoir.

#### **B. The Deterministic Logic Layer (DLL)**

* **Action:** Implement a hard-coded "Safety Interceptor" in Edge Functions (Supabase/Vercel).  
* **Hard Rules:**  
  1. If transport\_mode \=== 'sea' and vessel\_risk \=== 'high', the AI *must* propose an alternative rail/land gateway regardless of model preference.  
  2. If margin \< 5%, the AI *must* flag "Lane Level Risk" and escalate to a human.  
  3. Never output raw PII; use the provided Tokenization logic for MedTech packs.

#### **C. The "Skull" Simulation (Security)**

* **Action:** Mock the V5.0 Vault.  
* **Identity:** Implement strict JWT validation at the API edge.  
* **IRL:** Create a subject\_revocation\_list table. If a Subject ID is in this table, the Edge Function must strip that data from the RAG context *before* it reaches Gemini.

### **3\. LOGISTICS INTEGRATION PRESERVATION**

You must ensure the following adapters remain functional and are "hardened":

* **Freightos Adapter:** Map the totalPrice and transitTime fields into the Postgres metadata column for fast comparison.  
* **Xanetta Adapter:** Maintain the logic that joins internal "Contract Rates" with live index movements.  
* **Marine Traffic:** Ensure the vessel\_lat/vessel\_lon updates trigger an automated "Route Degradation" check in the background.

### **4\. UI/UX SPECIFICATIONS (REF: v4\_5\_app.jsx)**

* **Aesthetic:** High-density "Cyber-Purple" / "Sovereign" theme.  
* **Components:**  
  * **Sovereign Audit Log:** A real-time terminal showing DLL intercepts and RAG grounding sources.  
  * **Identity Ledger:** A UI for the "Kill Switch" simulation.  
  * **Instance Switcher:** Use the "Instances by Configuration" pattern (Logistics, Energy, MedTech).

### **5\. EXECUTION GUARDRAILS (ZERO-TRUST)**

* **No Hallucinations:** If the RAG retrieval returns a confidence score \< 0.7, the engine must state: "Insufficient sovereign data to support a high-confidence decision."  
* **Edge Failure:** If the Supabase connection fails, fallback to a "Offline Mode" cache using the PWA logic.  
* **Performance:** Sub-5s total round trip for inference. Measure and log latency for every request.

### **6\. DEFINITION OF DONE**

1. Sub-5s response time verified with pgvector.  
2. Manual "Kill Switch" successfully redacts data from a briefing.  
3. Freightos/Xanetta/Marine Traffic data is successfully "grounded" in the new Postgres reservoir.  
4. "Cyber-Purple" UI reflects the "Locked" status of the Sovereign Vault.

**ENGINEER: PROCEED WITH PHASE 1 (DATABASE MIGRATION) IMMEDIATELY.**
