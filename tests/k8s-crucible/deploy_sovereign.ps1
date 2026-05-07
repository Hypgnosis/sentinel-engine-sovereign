$ErrorActionPreference = "Stop"

$PROJECT_ID = $env:PROJECT_ID
if (-not $PROJECT_ID) {
    $PROJECT_ID = "ha-sentinel-core-v21"
}
$REGISTRY = "gcr.io/$PROJECT_ID"

Write-Host "============================================================"
Write-Host " SOVEREIGN STAMP MIGRATION: GKE Deployment & K6 Restart"
Write-Host "============================================================"

Write-Host "`n[1] Building the new Sovereign Guard..."
cd "d:\Documents\Sentinel Engine\sovereign-guard"
gcloud builds submit --project $PROJECT_ID --tag "$REGISTRY/sentinel-guard:latest" .

Write-Host "`n[2] Applying Hardened Manifests..."
cd "d:\Documents\Sentinel Engine\tests\k8s-crucible"
kubectl apply -f 00-certs.yaml
kubectl apply -f 03-pgbouncer.yaml
kubectl apply -f 05-sidecar-proxy.yaml

Write-Host "`n[3] Purging the Old K6 Job..."
kubectl delete job crucible-k6 -n sentinel-crucible --ignore-not-found

Write-Host "`n[4] Triggering New K6 Crucible Load Test..."
kubectl apply -f 06-k6-loadtest.yaml

Write-Host "`n[5] Tailing Logs..."
kubectl logs -f job/crucible-k6 -n sentinel-crucible
