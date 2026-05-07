import { execSync } from 'node:child_process';
import fetch from 'node-fetch';

async function run() {
  const apiKey = process.env.VITE_FIREBASE_API_KEY || "AIzaSyA8s14Jz81e9kvhu__6p2HzdNrT0MyJq2Q";
  const email = process.env.TEST_EMAIL || "admin@roserocket.com";
  const password = process.env.TEST_PASSWORD || "481bdc970e7a2f8b6255daa3";

  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });

  const data = await res.json();
  const token = data.idToken;

  const SENTINEL_ENDPOINT = 'https://us-central1-ha-sentinel-core-v21.cloudfunctions.net/sentinelInference';
  const apiRes = await fetch(SENTINEL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'X-Sentinel-Client': 'eval-harness/v4.1',
    },
    body: JSON.stringify({ query: "What is the current container shipping rate from Shanghai to Rotterdam?" }),
  });
  
  const text = await apiRes.text();
  console.log("Status:", apiRes.status);
  console.log("Body:", text);
}
run();
