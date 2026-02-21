#!/usr/bin/env tsx
/**
 * seed-deployment.ts — Insert the current deployment into Firestore.
 *
 * Use this when you've deployed / updated contracts manually and need to
 * sync the addresses to Firestore so the API picks them up on restart.
 *
 * Values are read from the .env files by default; every field can be
 * overridden via CLI flags.
 *
 * Usage (from apps/contracts/):
 *   npx tsx scripts/seed-deployment.ts
 *   npx tsx scripts/seed-deployment.ts --vk-hash <hash> --network testnet
 */

import * as path from 'path';
import * as fs from 'fs';
import minimist from 'minimist';
import * as dotenv from 'dotenv';
import * as admin from 'firebase-admin';

// ---------------------------------------------------------------------------
// Env loading
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const REPO_ROOT  = path.resolve(SCRIPT_DIR, '..', '..', '..');
const API_ENV    = path.join(REPO_ROOT, 'apps', 'api', '.env');
const WEB_ENV    = path.join(REPO_ROOT, 'apps', 'web', '.env.local');

if (fs.existsSync(API_ENV))  dotenv.config({ path: API_ENV,  override: false });
if (fs.existsSync(WEB_ENV))  dotenv.config({ path: WEB_ENV,  override: false });

// ---------------------------------------------------------------------------
// CLI args (all optional — fall back to env)
// ---------------------------------------------------------------------------

const argv = minimist(process.argv.slice(2), {
  string: ['network', 'heist-id', 'zk-verifier-id', 'vk-hash', 'game-hub', 'env-file'],
  default: { network: process.env.STELLAR_NETWORK ?? 'testnet' },
});

const NETWORK:          string = argv['network'];
const HEIST_ID:         string = argv['heist-id']       ?? process.env.HEIST_CONTRACT_ID          ?? '';
const ZK_VERIFIER_ID:   string = argv['zk-verifier-id'] ?? process.env.ZK_VERIFIER_CONTRACT_ID    ?? '';
const VK_HASH:          string = argv['vk-hash']        ?? process.env.NEXT_PUBLIC_VK_HASH         ?? process.env.VK_HASH ?? '';
const GAME_HUB:         string = argv['game-hub']        ?? process.env.NEXT_PUBLIC_GAME_HUB_CONTRACT_ID ?? 'CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG';

// Load an extra env file if provided (e.g. for Firebase creds).
const EXTRA_ENV: string = argv['env-file'] ?? '';
if (EXTRA_ENV && fs.existsSync(EXTRA_ENV)) dotenv.config({ path: EXTRA_ENV, override: true });

// Re-read Firebase env after extra dotenv load.
const FIREBASE_PROJECT_ID         = process.env.FIREBASE_PROJECT_ID;
const GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS;

// ---------------------------------------------------------------------------
// Validate required fields
// ---------------------------------------------------------------------------

const missing: string[] = [];
if (!HEIST_ID)       missing.push('HEIST_CONTRACT_ID (or --heist-id)');
if (!ZK_VERIFIER_ID) missing.push('ZK_VERIFIER_CONTRACT_ID (or --zk-verifier-id)');
if (!VK_HASH)        missing.push('VK_HASH / NEXT_PUBLIC_VK_HASH (or --vk-hash)');
if (!FIREBASE_PROJECT_ID) missing.push('FIREBASE_PROJECT_ID');

if (missing.length) {
  console.error('Missing required values:');
  missing.forEach(m => console.error(`  - ${m}`));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Firebase init
// ---------------------------------------------------------------------------

function initFirebase(): admin.firestore.Firestore {
  if (admin.apps.length) return admin.firestore(admin.apps[0]!);

  const credPath = GOOGLE_APPLICATION_CREDENTIALS
    ? path.isAbsolute(GOOGLE_APPLICATION_CREDENTIALS)
      ? GOOGLE_APPLICATION_CREDENTIALS
      : path.resolve(path.dirname(API_ENV), GOOGLE_APPLICATION_CREDENTIALS)
    : undefined;

  let credential: admin.credential.Credential;
  if (credPath && fs.existsSync(credPath)) {
    credential = admin.credential.cert(credPath as admin.ServiceAccount);
  } else {
    credential = admin.credential.applicationDefault();
  }

  admin.initializeApp({ credential, projectId: FIREBASE_PROJECT_ID });
  return admin.firestore();
}

// ---------------------------------------------------------------------------
// Write record
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('');
  console.log('==> Seed Firestore deployment record');
  console.log(`    network          : ${NETWORK}`);
  console.log(`    heistContractId  : ${HEIST_ID}`);
  console.log(`    zkVerifierContractId: ${ZK_VERIFIER_ID}`);
  console.log(`    vkHash           : ${VK_HASH}`);
  console.log(`    gameHub          : ${GAME_HUB}`);
  console.log('');

  const db = initFirebase();

  const deployedAt = new Date().toISOString();
  const record = {
    id:                   deployedAt,
    network:              NETWORK,
    deployedAt,
    heistContractId:      HEIST_ID,
    zkVerifierContractId: ZK_VERIFIER_ID,
    vkHash:               VK_HASH,
    gameHub:              GAME_HUB,
    mode:                 'manual-seed',
  };

  await db.collection('deployments').doc(deployedAt).set(record);

  console.log(`==> Written to Firestore: deployments/${deployedAt}`);
  console.log('    The API will pick up these addresses on next restart.');
  console.log('');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
