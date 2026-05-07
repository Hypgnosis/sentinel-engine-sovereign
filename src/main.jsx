import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import './index.css';
import App from './App.jsx';

// ─────────────────────────────────────────────────────
//  FIREBASE INITIALIZATION (Must run BEFORE any getAuth() call)
// ─────────────────────────────────────────────────────
// All values are sourced from VITE_FIREBASE_* environment variables.
// These are public client-side config values (NOT secrets).
// Security is enforced server-side via Firebase Auth + Security Rules.
const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

// Validate that essential config exists before initializing.
// Without this, getAuth() will throw a cryptic "No Firebase App" error.
if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
  console.error(
    'Sentinel Engine: FATAL — Missing Firebase configuration. ' +
    'Ensure VITE_FIREBASE_API_KEY and VITE_FIREBASE_PROJECT_ID are set in .env'
  );
} else {
  const app = initializeApp(firebaseConfig);
  // Securely hydrate an anonymous session so SentinelClient can acquire a JWT
  const auth = getAuth(app);
  signInAnonymously(auth).catch(err => {
    console.error('Sentinel Engine: Anonymous Auth failed:', err);
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// --- SENTINEL EDGE NODE: Service Worker Registration ---
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((registration) => {
        console.log('Sentinel Engine: Edge Node active. Scope:', registration.scope);
      })
      .catch((error) => {
        console.error('Sentinel Engine: Edge Node registration failed:', error);
      });
  });
}
