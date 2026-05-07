#!/bin/bash
set -e

# SENTINEL V5.5 — GKE Crucible Deployment Protocol (Cloud Build Edition)
PROJECT_ID=${PROJECT_ID:-"ha-sentinel-core-v21"}
REGISTRY="gcr.io/$PROJECT_ID"

echo "============================================================"
echo " SENTINEL V5.5 — GKE Crucible Deployment Protocol"
echo "============================================================"

echo "[1] Building and Pushing Images via Google Cloud Build..."

# 1. Hub API
echo "Building Hub API for project $PROJECT_ID..."
gcloud builds submit --project "$PROJECT_ID" --tag "$REGISTRY/sentinel-hub-api:latest" ../crucible-hub

# 2. Sidecar
echo "Building Sidecar for project $PROJECT_ID..."
gcloud builds submit --project "$PROJECT_ID" --tag "$REGISTRY/sentinel-sidecar:latest" ../../sidecar

# 3. Bridge Proxy
echo "Building Bridge Proxy for project $PROJECT_ID..."
gcloud builds submit --project "$PROJECT_ID" --tag "$REGISTRY/sentinel-bridge-proxy:latest" ../

echo "[2] Updating K8s Manifests with Project ID: $PROJECT_ID..."
# Fix for YAMLs (handles different gcr.io paths)
sed -i "s/gcr.io\/[a-zA-Z0-9-]*\//gcr.io\/$PROJECT_ID\//g" *.yaml

echo "[3] Applying Manifests to GKE..."
kubectl apply -f 01-namespace.yaml
kubectl apply -f 02-postgres.yaml
kubectl apply -f 03-pgbouncer.yaml
kubectl apply -f 04-hub-api.yaml
kubectl apply -f 05-sidecar-proxy.yaml
kubectl apply -f 06-k6-loadtest.yaml

echo "============================================================"
echo " DEPLOYMENT COMPLETE. Crucible is warming up."
echo " Run: kubectl logs -f job/crucible-k6 -n sentinel-crucible"
echo "============================================================"
