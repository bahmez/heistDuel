# Deployment Script

Script: `apps/contracts/scripts/deploy.ps1`

## But

Deployer automatiquement les 2 contrats Soroban:

1. `zk-verifier`
2. `heist` (avec l'adresse du `zk-verifier` deploye)

avec selection de reseau `testnet` ou `mainnet`.

## Prerequis

- `stellar` CLI installe et configure.
- `cargo` installe.
- target Rust WASM:
  - `rustup target add wasm32-unknown-unknown`
- Un `GameHub` deja deploye (adresse `C...`).
- Une identite source configuree (`stellar keys ls`).

## Usage

Depuis la racine du repo:

```powershell
.\apps\contracts\scripts\deploy.ps1 -Network testnet -Source alice -GameHub CABC...
```

Avec admin explicite:

```powershell
.\apps\contracts\scripts\deploy.ps1 -Network mainnet -Source prod -Admin GABC... -GameHub CDEF...
```

Si les WASM sont deja build:

```powershell
.\apps\contracts\scripts\deploy.ps1 -Network testnet -Source alice -GameHub CABC... -SkipBuild
```

## Parametres

- `-Network`: `testnet` ou `mainnet` (defaut: `testnet`)
- `-Source`: identite/compte source pour signer les tx de deploy
- `-GameHub`: identite ou adresse du contrat GameHub
- `-Admin`: identite ou adresse admin (defaut: adresse derivee de `-Source`)
- `-RustToolchain`: toolchain rustup pour le build Soroban (defaut: `1.90.0-x86_64-pc-windows-msvc`)
- `-SkipBuild`: saute la phase de build WASM

## Output

Le script ecrit un fichier:

- `apps/contracts/deployments/<network>.json`

avec:

- `zk_verifier_id`
- `heist_id`
- `network`, `source`, `admin`, `game_hub`
- timestamp UTC
