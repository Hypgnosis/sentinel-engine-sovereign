import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';

const API_URL = 'https://us-central1-ha-sentinel-core-v21.cloudfunctions.net/sentinelInference';

// Initialize Firebase to get a proper JWT
const firebaseConfig = {
  apiKey: process.env.VITE_FIREBASE_API_KEY || 'fake-key', // Will fail if not set, let's use the local API key from env or pass it
};

// We don't have to authenticate if we can just read the log via gcloud again, but let's try a different log command fast.
