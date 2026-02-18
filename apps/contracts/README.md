# Contracts Guide

Ce dossier contient deux contrats Soroban:

- `heist`: logique du jeu (sessions, tours, score, anti-triche de base).
- `zk-verifier`: validateur de preuves (liaison avec hash des inputs publics).

## Prerequis

- Rust + target WASM:
  - `rustup target add wasm32-unknown-unknown`
- Stellar CLI installe et configure:
  - `stellar network ls` doit contenir `testnet` et/ou `mainnet`
  - une identite source (ex: `alice`) existe dans `stellar keys ls`
- Un contrat `GameHub` deja deploye (adresse contract `C...`) pour passer au constructeur de `heist`.

## Contrat `zk-verifier`

Fichier: `apps/contracts/zk-verifier/src/lib.rs`

Fonctions principales:

- `__constructor(admin: Address)`
  - Initialise l'admin.
- `set_vk(vk_json: Bytes) -> BytesN<32>`
  - Admin uniquement.
  - Stocke la verifying key et son hash.
- `verify_proof_with_stored_vk(proof_blob: Bytes, public_inputs_hash: BytesN<32>) -> BytesN<32>`
  - Verifie un format de preuve minimal:
    - byte 0 == `1`
    - bytes `[1..33]` == `vk_hash`
    - bytes `[33..65]` == `public_inputs_hash`
  - Retourne `proof_id = keccak256(proof_blob)` et marque comme verifie.
- `is_verified(proof_id) -> bool`
- `get_vk_hash() -> Option<BytesN<32>>`

Notes:

- Ce validateur reste un validateur "lightweight" de format/preuve mock.
- Pour prod, remplace la logique interne de verification par un vrai verifier ZK.

## Contrat `heist`

Fichier: `apps/contracts/heist/src/lib.rs`

Fonctions principales:

- `__constructor(admin, game_hub, verifier)`
  - Configure admin + adresses des contrats dependants.
- `start_game(...)`
  - Cree une session.
  - Auth requise des 2 joueurs.
- `reveal_seed(...)`
  - Reveal des seeds engages.
- `begin_match(session_id)`
  - Passe le jeu en `Active` apres reveal des 2 seeds.
  - Auth des 2 joueurs requise.
- `submit_turn(session_id, player, proof_blob, public_turn)`
  - Auth joueur actif.
  - Verifie hash d'etat avant/apres.
  - Verifie deplacement (`path`) et contraintes anti-triche (loot/hazards recalcules).
  - Verifie preuve via `zk-verifier` avec hash des inputs publics.
- `get_expected_roll(session_id, player)`
  - Retourne le roll attendu pour le joueur au tour courant.
- `hash_turn_public(turn_public)`
  - Expose le hash exact des inputs publics utilises par la verification.
- `simulate_state_hash_after(session_id, public_turn)`
  - Simule le hash d'etat apres application d'un tour (read-only).
- `end_if_finished(session_id)`
  - Termine sur timeout ou loot complet.
- `get_player_view(session_id, player)`
  - Vue joueur (fog-of-war), auth joueur requise.
- `get_player_fog(session_id, player)`
  - Retourne le fog du joueur, auth requise.
- `get_game(session_id)`
  - Vue complete reservee admin (auth admin).

Admin:

- `set_admin`, `set_hub`, `set_verifier`, `upgrade`.

## Sequence d'utilisation recommandee

1. Deployer `zk-verifier`.
2. Deployer `heist` avec:
   - `admin` (adresse admin)
   - `game_hub` (contrat hub existant)
   - `verifier` (id du `zk-verifier`)
3. Appeler `set_vk` sur `zk-verifier` avec ta VK.
4. Cote client, utiliser `get_player_view` (pas `get_game`) pour l'UI joueur.

## Deploiement automatise

Script fourni:

- `apps/contracts/scripts/deploy.ps1`

Exemples:

```powershell
.\apps\contracts\scripts\deploy.ps1 -Network testnet -Source alice -GameHub CABC...
.\apps\contracts\scripts\deploy.ps1 -Network mainnet -Source prod-signer -GameHub CDEF... -Admin G...
```

Le script:

- build les 2 WASM
- deploie `zk-verifier`
- deploie `heist` avec l'id du verifier deploye
- ecrit un fichier de sortie:
  - `apps/contracts/deployments/<network>.json`

## Upgrade d'un contrat heist deja deploye

Exemple testnet (admin requis):

```powershell
stellar contract install `
  --network testnet `
  --source-account heist-testnet-deployer `
  --wasm target/wasm32v1-none/release/heist.wasm

stellar contract invoke `
  --network testnet `
  --source-account heist-testnet-deployer `
  --id CDG5LXIM2EAIAEEPVZUE46SNIXOWXRW3PIAJJ3GQA4GEXX7HLO7K3YAG `
  -- upgrade `
  --new_wasm_hash <WASM_HASH_HEX>
```
