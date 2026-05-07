$ErrorActionPreference = "Stop"

$PROJECT_ID = $env:PROJECT_ID
if (-not $PROJECT_ID) {
    $PROJECT_ID = "ha-sentinel-core-v21"
}
$REGISTRY = "gcr.io/$PROJECT_ID"

Write-Host "============================================================"
Write-Host " SENTINEL V5.5 - GKE Crucible Deployment Protocol"
Write-Host "============================================================"

Write-Host ""
Write-Host "[1] Building and Pushing Images via Google Cloud Build..."

Write-Host "Building Hub API for project $PROJECT_ID..."
gcloud builds submit --project $PROJECT_ID --tag "$REGISTRY/sentinel-hub-api:latest" ../crucible-hub

Write-Host "Building Sidecar for project $PROJECT_ID..."
gcloud builds submit --project $PROJECT_ID --tag "$REGISTRY/sentinel-sidecar:latest" ../../sidecar

Write-Host "Building Bridge Proxy for project $PROJECT_ID..."
gcloud builds submit --project $PROJECT_ID --tag "$REGISTRY/sentinel-bridge-proxy:latest" ../

Write-Host ""
Write-Host "[2] Updating K8s Manifests with Project ID: $PROJECT_ID..."
Get-ChildItem -Filter *.yaml | ForEach-Object {
    $content = Get-Content $_.FullName
    $newContent = $content -replace "gcr\.io/[a-zA-Z0-9-]+/", "gcr.io/$PROJECT_ID/"
    Set-Content -Path $_.FullName -Value $newContent
}

Write-Host ""
Write-Host "[3] Applying Manifests to GKE..."
kubectl apply -f 01-namespace.yaml
kubectl apply -f 02-postgres.yaml
kubectl apply -f 03-pgbouncer.yaml
kubectl apply -f 04-hub-api.yaml
kubectl apply -f 05-sidecar-proxy.yaml
kubectl apply -f 06-k6-loadtest.yaml

Write-Host ""
Write-Host "============================================================"
Write-Host " DEPLOYMENT COMPLETE. Crucible is warming up."
Write-Host " Run: kubectl logs -f job/crucible-k6 -n sentinel-crucible"
Write-Host "============================================================"
