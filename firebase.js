import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { getAuth } from 'firebase-admin/auth';

const PROJECT_ID = 'driply-b7ffb';
const DB_URL = 'https://driply-b7ffb-default-rtdb.firebaseio.com';

function getServiceAccount() {
  const envKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  if (!envKey) {
    console.error('FIREBASE_SERVICE_ACCOUNT_KEY not set');
    process.exit(1);
  }
  try {
    const raw = envKey.startsWith('{') ? envKey : Buffer.from(envKey, 'base64').toString('utf-8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY:', e.message);
    process.exit(1);
  }
}

function init() {
  if (getApps().length) return;

  const serviceAccount = getServiceAccount();
  initializeApp({
    credential: cert(serviceAccount),
    databaseURL: DB_URL,
    projectId: PROJECT_ID,
  });

  console.log('[FIREBASE] Admin SDK initialized');
}

function db() {
  init();
  return getDatabase();
}

function auth() {
  init();
  return getAuth();
}

export { init, db, auth, PROJECT_ID, DB_URL };
