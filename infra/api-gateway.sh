#!/bin/bash
PROJECT_ID="ha-sentinel-core-v21"
REGION="us-central1"

echo "1. Enabling API Gateway Services..."
gcloud services enable apigateway.googleapis.com servicemanagement.googleapis.com servicecontrol.googleapis.com --project $PROJECT_ID

echo "2. Creating API Configuration from openapi.yaml..."
gcloud api-gateway api-configs create sentinel-v4-config \
  --api=sentinel-engine-api \
  --openapi-spec=docs/openapi.yaml \
  --project=$PROJECT_ID \
  --backend-auth-service-account=COMPUTE_ENGINE_DEFAULT_SERVICE_ACCOUNT

echo "3. Deploying API Gateway (This takes ~2 minutes)..."
gcloud api-gateway gateways create sentinel-gateway \
  --api=sentinel-engine-api \
  --api-config=sentinel-v4-config \
  --location=$REGION \
  --project=$PROJECT_ID

echo "DONE. API Gateway deployed."
