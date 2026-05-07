// run_eval.js
import { execSync } from 'node:child_process';

async function run() {

  const apiKey = process.env.VITE_FIREBASE_API_KEY || "AIzaSyA8s14Jz81e9kvhu__6p2HzdNrT0MyJq2Q";


  const email = process.env.TEST_EMAIL || "admin@roserocket.com";
  const password = process.env.TEST_PASSWORD || "481bdc970e7a2f8b6255daa3";

  console.log("Obteniendo token seguro de Firebase...");

  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });

  const data = await res.json();

  if (!data.idToken) {
    console.error("Fallo al iniciar sesión. Revisa tu API Key o contraseña:", data);
    return;
  }

  console.log("¡Token adquirido! Ejecutando el Juez de Evaluación...\n");

  // Ejecuta la prueba pasándole el token automáticamente
  execSync(`node --test tests/backend-eval.test.js`, {
    env: { ...process.env, SENTINEL_AUTH_TOKEN: data.idToken },
    stdio: 'inherit'
  });
}

run();
