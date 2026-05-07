# GKE Final Deployment Steps

### 1. Install kubectl
```powershell
gcloud components install kubectl
```
*(CLOSE and RE-OPEN your terminal after this finishes!)*

### 2. Find your Cluster Info
Run this to see your cluster name and region:
```powershell
gcloud container clusters list --project ha-sentinel-core-v21
```

### 3. Connect to your GKE Cluster
Use the NAME and LOCATION from the step above (Example):
```powershell
# DO NOT include the < > symbols!
gcloud container clusters get-credentials YOUR_NAME --region YOUR_LOCATION --project ha-sentinel-core-v21
```

### 4. Deploy everything
```powershell
cd "d:\Documents\Sentinel Engine\tests\k8s-crucible"
kubectl apply -f .
```

### 5. Watch the 5,000 VU Load Test
```powershell
kubectl logs -f job/crucible-k6 -n sentinel-crucible
```
