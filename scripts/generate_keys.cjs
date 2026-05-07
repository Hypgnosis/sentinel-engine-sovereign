const crypto = require('crypto');
const fs = require('fs');

console.log('Generating ECDSA P-256 Key Pair for Sentinel Sovereign Asymmetric Boot...');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: {
    type: 'spki',
    format: 'pem'
  },
  privateKeyEncoding: {
    type: 'pkcs8',
    format: 'pem'
  }
});

fs.writeFileSync('sentinel_private.pem', privateKey);
fs.writeFileSync('sentinel_public.pem', publicKey);

console.log('✅ Keys generated successfully!');
console.log(' - sentinel_private.pem');
console.log(' - sentinel_public.pem');
console.log('\nRun the following commands to upload them to GCP Secret Manager:');
console.log('--------------------------------------------------------------');
console.log('gcloud secrets create SENTINEL_PRIVATE_KEY --replication-policy="automatic"');
console.log('gcloud secrets versions add SENTINEL_PRIVATE_KEY --data-file="sentinel_private.pem"');
console.log('');
console.log('gcloud secrets create SENTINEL_PUBLIC_KEY --replication-policy="automatic"');
console.log('gcloud secrets versions add SENTINEL_PUBLIC_KEY --data-file="sentinel_public.pem"');
console.log('--------------------------------------------------------------');
