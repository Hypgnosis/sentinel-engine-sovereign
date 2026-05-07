// check_auth.mjs
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import fs from 'fs';

let serviceAccount;
try {
  serviceAccount = JSON.parse(fs.readFileSync('./sentinel-admin-key.json', 'utf8'));
} catch (e) {
  serviceAccount = { projectId: 'ha-sentinel-core-v21' }; // Try ADC
}

initializeApp({ projectId: 'ha-sentinel-core-v21' });

async function check() {
  try {
    const user = await getAuth().getUserByEmail('admin@roserocket.com');
    console.log("USER:", user.uid);
    console.log("CUSTOM CLAIMS:", user.customClaims);
  } catch (err) {
    console.error(err);
  }
}
check();
