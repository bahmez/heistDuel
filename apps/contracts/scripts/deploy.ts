#!/usr/bin/env tsx
/**
 * deploy.ts — Stellar/Soroban contract deploy script
 *
 * Replaces deploy.ps1 with a cross-platform TypeScript equivalent.
 * After a successful deploy the record is written to Firestore so the API and
 * frontend automatically pick up the new contract addresses without needing
 * manual .env edits.
 *
 * Usage:
 *   tsx scripts/deploy.ts --source <account> [options]
 *
 * Options:
 *   --network         testnet | mainnet              (default: testnet)
 *   --source          stellar account alias or secret key  [required]
 *   --game-hub        game-hub contract ID            (default: CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG)
 *   --admin           admin address (defaults to --source address)
 *   --rust-toolchain  rustup toolchain override
 *   --skip-build      skip cargo build step
 *   --upgrade-heist-id  upgrade an existing heist contract in-place
 *   --env-file        path to .env file with Firebase credentials
 *                     (default: ../../apps/api/.env relative to this script)
 *   --vk-file         path to VK JSON fields file (`vk_fields.json`) or binary VK
 *                     (default: apps/circuits/turn_validity/target/vk/vk_fields.json)
 *   --skip-vk         skip the set_vk call entirely (useful when upgrading heist only)
 *   --update-vk-id    update VK on an existing verifier contract and exit (no full deploy)
 *                     e.g.: tsx scripts/deploy.ts --update-vk-id CCXXX... --vk-file ./vk
 */

import * as path from 'path';
import * as fs from 'fs';
import { spawnSync } from 'child_process';
import minimist from 'minimist';
import * as dotenv from 'dotenv';
import * as admin from 'firebase-admin';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const DEFAULT_GAME_HUB = 'CB4VZAT2U3UC6XFK3N23SKRF2NDCMP3QHJYMCHHFMZO7MRQO6DQ2EMYG';

const argv = minimist(process.argv.slice(2), {
  string: ['network', 'source', 'game-hub', 'admin', 'rust-toolchain', 'upgrade-heist-id', 'env-file', 'vk-file', 'update-vk-id'],
  boolean: ['skip-build', 'skip-vk'],
  default: {
    network:    'testnet',
    source:     'heist-testnet-deployer',
    'game-hub': DEFAULT_GAME_HUB,
  },
});

const NETWORK: string          = argv['network'];
const SOURCE: string           = argv['source'];
const GAME_HUB: string         = argv['game-hub'];
const ADMIN_ARG: string        = argv['admin'] ?? '';
// stellar contract build blacklists certain nightly/stable versions.
// Default to 1.90.0 which is known-good for wasm32v1-none Soroban builds.
const RUST_TOOLCHAIN: string   = argv['rust-toolchain'] ?? '1.90.0';
const SKIP_BUILD: boolean      = argv['skip-build'];
const SKIP_VK: boolean         = argv['skip-vk'];
const UPGRADE_HEIST_ID: string = argv['upgrade-heist-id'] ?? '';
const UPDATE_VK_ID: string     = argv['update-vk-id'] ?? '';
const VK_FILE_ARG: string      = argv['vk-file'] ?? '';
const NETWORK_PASSPHRASE =
  NETWORK === 'testnet'
    ? 'Test SDF Network ; September 2015'
    : 'Public Global Stellar Network ; September 2015';
const NETWORK_ARGS = [
  '--network',
  NETWORK,
  '--network-passphrase',
  NETWORK_PASSPHRASE,
] as const;
if (!['testnet', 'mainnet'].includes(NETWORK)) {
  console.error(`Error: --network must be "testnet" or "mainnet". Got "${NETWORK}".`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.resolve(__dirname);
const REPO_ROOT  = path.resolve(SCRIPT_DIR, '../../..');
const DEPLOY_DIR = path.join(REPO_ROOT, 'apps', 'contracts', 'deployments');
const ENV_FILE   = argv['env-file'] ?? path.join(REPO_ROOT, 'apps', 'api', '.env');

fs.mkdirSync(DEPLOY_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Load .env for Firebase credentials
// ---------------------------------------------------------------------------

dotenv.config({ path: ENV_FILE });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function step(label: string): void {
  console.log('');
  console.log(`==> ${label}`);
}

function run(...args: string[]): string {
  const result = spawnSync(args[0]!, args.slice(1), {
    encoding: 'utf8',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr ?? '').trim() || `Command failed: ${args.join(' ')}`);
  }
  return (result.stdout ?? '').trim();
}

/** Resolved absolute path to stellar.exe (detected once at startup). */
const STELLAR_BIN: string = (() => {
  try {
    // On Windows, 'where stellar' returns the full path.
    const r = spawnSync('where', ['stellar'], { encoding: 'utf8' });
    if (r.status === 0) return r.stdout.trim().split(/\r?\n/)[0]!.trim();
  } catch { /* ignore */ }
  return 'stellar'; // fallback to PATH lookup
})();

function stellar(...args: string[]): string {
  // Use spawnSync without shell so the binary is called directly.
  // This avoids cmd.exe / PowerShell escaping issues with paths on Windows.
  const result = spawnSync(STELLAR_BIN, args, {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: process.env,
  });

  const stdout = (result.stdout ?? '').trim();
  const stderr = (result.stderr ?? '').trim();

  if (result.status !== 0 || result.error) {
    throw new Error(
      `stellar ${args.join(' ')} failed (exit ${result.status ?? '?'})` +
        (stdout ? `\n  stdout: ${stdout}` : '') +
        (stderr ? `\n  stderr: ${stderr}` : '') +
        (result.error ? `\n  error: ${result.error.message}` : ''),
    );
  }

  return stdout;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Retry wrapper for transient Stellar CLI failures (network / RPC hiccups).
 * If `--quiet` command fails, we retry with the same args.
 */
function stellarRetry(args: string[], label: string, attempts = 3, delayMs = 5000): string {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return stellar(...args);
    } catch (err) {
      lastErr = err;
      if (i === attempts) break;
      console.warn(`  ${label} failed (attempt ${i}/${attempts}), retrying in ${delayMs / 1000}s...`);
      sleep(delayMs);
    }
  }
  throw lastErr;
}

function resolveAddress(value: string): string {
  // Already a valid Stellar address (56-char G or C)
  if (/^[GC][A-Z2-7]{55}$/.test(value)) return value;
  const out = stellar('--quiet', 'keys', 'public-key', value);
  if (!out) throw new Error(`Cannot resolve address for "${value}".`);
  return out;
}

function extractContractId(output: string, label: string): string {
  const matches = [...output.matchAll(/\bC[A-Z2-7]{55}\b/g)];
  if (!matches.length) throw new Error(`Deployment ${label} failed: no contract ID in output.\n${output}`);
  return matches[matches.length - 1]![0];
}

function stripQuotes(s: string): string {
  return s.trim().replace(/^"|"$/g, '');
}

function setEnvVar(filePath: string, key: string, value: string): void {
  if (!fs.existsSync(filePath)) return;
  let content = fs.readFileSync(filePath, 'utf8');
  if (new RegExp(`^${key}=`, 'm').test(content)) {
    content = content.replace(new RegExp(`^${key}=.*`, 'm'), `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`  Updated ${key} in ${path.basename(filePath)}`);
}

/**
 * Loads the Groth16 verification key binary as a hex string.
 *
 * Resolution order:
 *   1. --vk-file CLI option (any binary file)
 *   2. apps/circuits/turn_validity_g16/build/vk.bin  (generated by npm run setup)
 *   3. 32-byte placeholder (for local testing — logs a warning)
 *
 * The VK is generated by running inside apps/circuits/turn_validity_g16/:
 *   npm install
 *   npm run compile      # circom compilation (requires circom in PATH)
 *   npm run setup        # Groth16 trusted setup + export vk.bin
 */
function resolveVkHex(): { hex: string; fromFile: boolean } {
  const groth16VkBin = path.join(
    REPO_ROOT,
    'apps',
    'circuits',
    'turn_validity_g16',
    'build',
    'vk.bin',
  );

  const candidates: string[] = [];
  if (VK_FILE_ARG) candidates.push(VK_FILE_ARG);
  candidates.push(groth16VkBin);

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;

    let filePath = candidate;
    const stat = fs.statSync(candidate);
    if (stat.isDirectory()) {
      const binPath = path.join(candidate, 'vk.bin');
      if (fs.existsSync(binPath)) {
        filePath = binPath;
      } else {
        console.warn(`  WARNING: ${candidate} has no vk.bin`);
        continue;
      }
    }

    const buf = fs.readFileSync(filePath);
    console.log(`  Loading Groth16 VK from: ${filePath} (${buf.length} bytes)`);
    return { hex: buf.toString('hex'), fromFile: true };
  }

  console.warn('  WARNING: No Groth16 VK found. Using placeholder bytes.');
  console.warn('  Generate it by running inside apps/circuits/turn_validity_g16/:');
  console.warn('    npm install');
  console.warn('    npm run compile     # requires circom in PATH');
  console.warn('    npm run setup       # trusted setup + export vk.bin');
  // 580-byte placeholder (correct size for Groth16 VK with 1 public input).
  return { hex: 'ab'.repeat(580), fromFile: false };
}

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

try { run(STELLAR_BIN, '--version'); } catch { console.error('Error: "stellar" CLI not found.'); process.exit(1); }
try { run('cargo', '--version'); }   catch { console.error('Error: "cargo" not found.'); process.exit(1); }

// Verify network is configured
const configuredNetworks = run(STELLAR_BIN, '--quiet', 'network', 'ls').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
if (!configuredNetworks.includes(NETWORK)) {
  console.error(`Error: Network "${NETWORK}" not configured. Available: ${configuredNetworks.join(', ')}`);
  process.exit(1);
}

const gameHubAddress  = resolveAddress(GAME_HUB);
const adminAddress    = resolveAddress(ADMIN_ARG || SOURCE);

// ---------------------------------------------------------------------------
// --update-vk-id: update VK on an existing verifier contract and exit
// ---------------------------------------------------------------------------

if (UPDATE_VK_ID) {
  step(`Update VK on zk-verifier ${UPDATE_VK_ID} (${NETWORK})`);
  const { hex: vkHex, fromFile } = resolveVkHex();
  const vkRaw = stellar(
    'contract', 'invoke',
    ...NETWORK_ARGS,
    '--source-account', SOURCE,
    '--id', UPDATE_VK_ID,
    '--', 'set_vk',
      '--vk', vkHex,
  );
  const hash = stripQuotes(vkRaw.split('\n').pop()!);
  console.log(`  VK hash: ${hash}${fromFile ? '' : ' (placeholder)'}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Firebase init
// ---------------------------------------------------------------------------

function initFirebase(): admin.firestore.Firestore | null {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const credPathRaw = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const credPath = credPathRaw
    ? path.isAbsolute(credPathRaw)
      ? credPathRaw
      : path.resolve(path.dirname(ENV_FILE), credPathRaw)
    : undefined;

  if (!projectId) {
    console.warn('  FIREBASE_PROJECT_ID not set — skipping Firestore write.');
    return null;
  }

  try {
    if (admin.apps.length) {
      return admin.firestore(admin.apps[0]!);
    }

    let credential: admin.credential.Credential;
    if (credPath) {
      try {
        credential = admin.credential.cert(credPath as admin.ServiceAccount);
      } catch (err) {
        console.warn(
          `  Invalid GOOGLE_APPLICATION_CREDENTIALS path (${credPath}). ` +
            `Falling back to Application Default Credentials (Cloud Run/GCP). Reason: ${err}`,
        );
        credential = admin.credential.applicationDefault();
      }
    } else {
      credential = admin.credential.applicationDefault();
    }

    const app = admin.initializeApp({ credential, projectId });
    return admin.firestore(app);
  } catch (err) {
    console.warn(`  Firebase init failed — skipping Firestore write: ${err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const ZK_WASM    = path.join(REPO_ROOT, 'target', 'wasm32v1-none', 'release', 'zk_verifier.wasm');
const HEIST_WASM = path.join(REPO_ROOT, 'target', 'wasm32v1-none', 'release', 'heist.wasm');

if (!SKIP_BUILD) {
  // Force cargo output into the workspace target dir so the deploy script can
  // locate the WASM regardless of stellar CLI's internal temp-dir behaviour.
  const toolchainEnv = {
    ...(RUST_TOOLCHAIN ? { ...process.env, RUSTUP_TOOLCHAIN: RUST_TOOLCHAIN } : process.env),
    CARGO_TARGET_DIR: path.join(REPO_ROOT, 'target'),
  };

  if (!UPGRADE_HEIST_ID) {
    // Full deploy: build both contracts.
    // Remove existing WASM artifacts before building to force a full recompile.
    if (fs.existsSync(ZK_WASM))    fs.unlinkSync(ZK_WASM);
    if (fs.existsSync(HEIST_WASM)) fs.unlinkSync(HEIST_WASM);

    step('Build zk-verifier wasm');
    const buildZk = spawnSync(
      STELLAR_BIN,
      ['contract', 'build', '--manifest-path', path.join(REPO_ROOT, 'apps/contracts/zk-verifier/Cargo.toml')],
      { stdio: 'inherit', env: toolchainEnv, cwd: REPO_ROOT },
    );
    if (buildZk.status !== 0) throw new Error('Build zk-verifier failed.');
  } else {
    // Upgrade mode: only rebuild the heist contract.
    if (fs.existsSync(HEIST_WASM)) fs.unlinkSync(HEIST_WASM);
  }

  step('Build heist wasm');
  const buildHeist = spawnSync(
    STELLAR_BIN,
    ['contract', 'build', '--manifest-path', path.join(REPO_ROOT, 'apps/contracts/heist/Cargo.toml')],
    { stdio: 'inherit', env: toolchainEnv, cwd: REPO_ROOT },
  );
  if (buildHeist.status !== 0) throw new Error('Build heist failed.');
}

if (!UPGRADE_HEIST_ID && !fs.existsSync(ZK_WASM)) throw new Error(`WASM not found: ${ZK_WASM}`);
if (!fs.existsSync(HEIST_WASM)) throw new Error(`WASM not found: ${HEIST_WASM}`);

// ---------------------------------------------------------------------------
// Deploy or upgrade
// ---------------------------------------------------------------------------

let zkContractId    = '';
let heistContractId = '';
let wasmHash        = '';

if (UPGRADE_HEIST_ID) {
  // ---- Upgrade mode -------------------------------------------------------
  heistContractId = UPGRADE_HEIST_ID.trim();

  const existingFile = path.join(DEPLOY_DIR, `${NETWORK}.json`);
  if (!fs.existsSync(existingFile)) {
    throw new Error('--upgrade-heist-id requires an existing deployment JSON file with the zk-verifier id.');
  }
  const existing = JSON.parse(fs.readFileSync(existingFile, 'utf8'));
  zkContractId = existing.zk_verifier_id ?? '';
  console.log(`Reusing zk-verifier: ${zkContractId}`);

  step(`Upload new heist WASM (${NETWORK})`);
  wasmHash = stripQuotes(stellar(
    'contract', 'upload',
    ...NETWORK_ARGS,
    '--source-account', SOURCE,
    '--wasm', HEIST_WASM,
  ).split('\n').pop()!);
  console.log(`  WASM hash: ${wasmHash}`);
  if (!wasmHash) throw new Error('WASM upload failed.');

  step(`Upgrade heist contract in-place (${NETWORK})`);
  stellar(
    'contract', 'invoke',
    ...NETWORK_ARGS,
    '--source-account', SOURCE,
    '--id', heistContractId,
    '--', 'upgrade',
    '--new-wasm-hash', wasmHash,
  );
  console.log(`  Contract ${heistContractId} upgraded to ${wasmHash}`);

} else {
  // ---- Full deploy ---------------------------------------------------------
  step(`Deploy zk-verifier (${NETWORK})`);
  const zkRaw = stellarRetry([
    'contract', 'deploy',
    ...NETWORK_ARGS,
    '--source-account', SOURCE,
    '--wasm', ZK_WASM,
    '--', '--admin', adminAddress,
  ], 'zk-verifier deploy');
  zkContractId = extractContractId(zkRaw, 'zk-verifier');
  console.log(`  zk-verifier: ${zkContractId}`);

  step(`Deploy heist (${NETWORK})`);
  let heistRaw = '';
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      heistRaw = stellar(
        'contract', 'deploy',
        ...NETWORK_ARGS,
        '--source-account', SOURCE,
        '--wasm', HEIST_WASM,
        '--', '--admin', adminAddress,
        '--game-hub', gameHubAddress,
        '--verifier', zkContractId,
      );
      break;
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) throw err;
      console.log(`  Attempt ${attempt} failed, retrying in 5s…`);
      sleep(5000);
    }
  }
  heistContractId = extractContractId(heistRaw, 'heist');
  console.log(`  heist: ${heistContractId}`);
}

// ---------------------------------------------------------------------------
// Init VK
// ---------------------------------------------------------------------------

let vkHash = '';

if (!UPGRADE_HEIST_ID && !SKIP_VK) {
  step(`Init VK on zk-verifier (${NETWORK})`);
  const { hex: vkHex, fromFile } = resolveVkHex();
  const vkRaw = stellar(
    'contract', 'invoke',
    ...NETWORK_ARGS,
    '--source-account', SOURCE,
    '--id', zkContractId,
    '--', 'set_vk',
    '--vk', vkHex,
  );
  vkHash = stripQuotes(vkRaw.split('\n').pop()!);
  console.log(`  VK hash: ${vkHash}${fromFile ? '' : ' (placeholder)'}`);
} else {
  const existingFile = path.join(DEPLOY_DIR, `${NETWORK}.json`);
  if (fs.existsSync(existingFile)) {
    const existing = JSON.parse(fs.readFileSync(existingFile, 'utf8'));
    vkHash = existing.vk_hash ?? '';
    console.log(`\n==> Reusing VK hash from existing deployment: ${vkHash}`);
  }
}

// ---------------------------------------------------------------------------
// Update env files (backward compat — Firestore is the source of truth)
// ---------------------------------------------------------------------------

step('Update environment files');
if (!UPGRADE_HEIST_ID) {
  const webEnv  = path.join(REPO_ROOT, 'apps', 'web', '.env.local');
  const apiEnv  = path.join(REPO_ROOT, 'apps', 'api', '.env');
  const pkgConst = path.join(REPO_ROOT, 'packages', 'stellar', 'src', 'constants.ts');

  setEnvVar(webEnv, 'NEXT_PUBLIC_HEIST_CONTRACT_ID',       heistContractId);
  setEnvVar(webEnv, 'NEXT_PUBLIC_ZK_VERIFIER_CONTRACT_ID', zkContractId);
  if (vkHash) setEnvVar(webEnv, 'NEXT_PUBLIC_VK_HASH',     vkHash);

  setEnvVar(apiEnv, 'HEIST_CONTRACT_ID',       heistContractId);
  setEnvVar(apiEnv, 'ZK_VERIFIER_CONTRACT_ID', zkContractId);

  if (fs.existsSync(pkgConst)) {
    let c = fs.readFileSync(pkgConst, 'utf8');
    c = c.replace(/(export const HEIST_CONTRACT_ID\s*=\s*\n?\s*)"[^"]+"/m, `$1"${heistContractId}"`);
    c = c.replace(/(export const ZK_VERIFIER_CONTRACT_ID\s*=\s*\n?\s*)"[^"]+"/m, `$1"${zkContractId}"`);
    fs.writeFileSync(pkgConst, c, 'utf8');
    console.log('  Updated constants.ts');
  }
} else {
  console.log('  Upgrade mode — contract addresses unchanged, no env var update needed.');
}

// ---------------------------------------------------------------------------
// Save deployment record to JSON (legacy, for init-vk.ps1 compat)
// ---------------------------------------------------------------------------

step('Save deployment record (JSON)');
const outFile = path.join(DEPLOY_DIR, `${NETWORK}.json`);
const record = {
  deployed_at_utc:  new Date().toISOString(),
  network:          NETWORK,
  source:           SOURCE,
  admin:            adminAddress,
  game_hub:         gameHubAddress,
  zk_verifier_id:  zkContractId,
  heist_id:         heistContractId,
  vk_hash:          vkHash,
  ...(wasmHash ? { wasm_hash: wasmHash } : {}),
  mode: UPGRADE_HEIST_ID ? 'upgrade' : 'full',
};
fs.writeFileSync(outFile, JSON.stringify(record, null, 2), 'utf8');
console.log(`  Saved: ${outFile}`);

// ---------------------------------------------------------------------------
// Save deployment record to Firestore (source of truth for the API)
// ---------------------------------------------------------------------------

async function saveToFirestore(): Promise<void> {
  step('Save deployment record (Firestore)');
  const db = initFirebase();

  if (!db) {
    console.log('  Skipped (Firebase not configured).');
    return;
  }

  const deployedAt = record.deployed_at_utc;
  const firestoreRecord = {
    id:                  deployedAt,
    network:             NETWORK,
    deployedAt,
    source:              SOURCE,
    admin:               adminAddress,
    gameHub:             gameHubAddress,
    heistContractId,
    zkVerifierContractId: zkContractId,
    vkHash,
    ...(wasmHash ? { wasmHash } : {}),
    mode: UPGRADE_HEIST_ID ? 'upgrade' : 'full',
  };

  try {
    await db.collection('deployments').doc(deployedAt).set(firestoreRecord);
    console.log(`  Written to Firestore: deployments/${deployedAt}`);
  } catch (err) {
    console.error(`  Firestore write failed: ${err}`);
    console.warn('  Contract addresses are still available in the JSON file.');
  }
}

// ---------------------------------------------------------------------------
// Run async part and print summary
// ---------------------------------------------------------------------------

saveToFirestore()
  .then(() => {
    console.log('');
    console.log('========================================');
    console.log('Deployment complete');
    console.log('========================================');
    console.log(`zk-verifier : ${zkContractId}`);
    console.log(`heist       : ${heistContractId}`);
    if (vkHash)   console.log(`VK hash     : ${vkHash}`);
    if (wasmHash) console.log(`WASM hash   : ${wasmHash}`);
    console.log(`Record JSON : ${outFile}`);
    console.log('');
    console.log('The API will automatically load the new addresses on next restart.');
  })
  .catch((err) => {
    console.error('Fatal error during Firestore save:', err);
    process.exit(1);
  });
