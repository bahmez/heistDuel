param(
    [ValidateSet("testnet", "mainnet")]
    [string]$Network = "testnet",
    [Parameter(Mandatory = $true)]
    [string]$Source,
    [Parameter(Mandatory = $true)]
    [string]$GameHub,
    [string]$Admin,
    [string]$RustToolchain = "1.90.0-x86_64-pc-windows-msvc",
    [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Assert-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Commande requise introuvable: $Name"
    }
}

function Resolve-Address {
    param([string]$Value)
    if ($Value -match "^[GC][A-Z2-7]{55}$") {
        return $Value
    }
    $out = & stellar --quiet keys public-key $Value
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($out)) {
        throw "Impossible de resoudre l'adresse pour '$Value'."
    }
    return $out.Trim()
}

function Invoke-Step {
    param(
        [string]$Label,
        [scriptblock]$Action
    )
    Write-Host "==> $Label"
    & $Action
}

Assert-Command "stellar"
Assert-Command "cargo"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$deployDir = Join-Path $repoRoot "apps\contracts\deployments"
New-Item -ItemType Directory -Path $deployDir -Force | Out-Null

$networks = (& stellar --quiet network ls) -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
if ($networks -notcontains $Network) {
    throw "Reseau '$Network' absent de la config Stellar CLI. Reseaux disponibles: $($networks -join ', ')"
}

$gameHubAddress = Resolve-Address $GameHub
$adminAddress = if ([string]::IsNullOrWhiteSpace($Admin)) { Resolve-Address $Source } else { Resolve-Address $Admin }

if (-not $SkipBuild) {
    Invoke-Step "Build zk-verifier wasm" {
        $env:RUSTUP_TOOLCHAIN = $RustToolchain
        & stellar contract build --manifest-path (Join-Path $repoRoot "apps/contracts/zk-verifier/Cargo.toml")
        if ($LASTEXITCODE -ne 0) { throw "Build zk-verifier echoue." }
    }
    Invoke-Step "Build heist wasm" {
        $env:RUSTUP_TOOLCHAIN = $RustToolchain
        & stellar contract build --manifest-path (Join-Path $repoRoot "apps/contracts/heist/Cargo.toml")
        if ($LASTEXITCODE -ne 0) { throw "Build heist echoue." }
    }
}

$zkWasm = Join-Path $repoRoot "target\wasm32v1-none\release\zk_verifier.wasm"
$heistWasm = Join-Path $repoRoot "target\wasm32v1-none\release\heist.wasm"

if (-not (Test-Path $zkWasm)) { throw "WASM introuvable: $zkWasm" }
if (-not (Test-Path $heistWasm)) { throw "WASM introuvable: $heistWasm" }

$zkContractId = ""
$heistContractId = ""

Invoke-Step "Deploy zk-verifier ($Network)" {
    $zkRaw = & stellar --quiet contract deploy `
        --network $Network `
        --source-account $Source `
        --wasm $zkWasm `
        -- `
        --admin $adminAddress
    if ($LASTEXITCODE -ne 0) {
        throw "Deployment zk-verifier echoue."
    }
    $zkContractId = ([string]$zkRaw).Trim()
    if ([string]::IsNullOrWhiteSpace($zkContractId)) {
        throw "Deployment zk-verifier echoue: contract id vide."
    }
}

Invoke-Step "Deploy heist ($Network)" {
    $heistRaw = & stellar --quiet contract deploy `
        --network $Network `
        --source-account $Source `
        --wasm $heistWasm `
        -- `
        --admin $adminAddress `
        --game-hub $gameHubAddress `
        --verifier $zkContractId
    if ($LASTEXITCODE -ne 0) {
        throw "Deployment heist echoue."
    }
    $heistContractId = ([string]$heistRaw).Trim()
    if ([string]::IsNullOrWhiteSpace($heistContractId)) {
        throw "Deployment heist echoue: contract id vide."
    }
}

$output = [ordered]@{
    deployed_at_utc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    network = $Network
    source = $Source
    admin = $adminAddress
    game_hub = $gameHubAddress
    zk_verifier_id = $zkContractId
    heist_id = $heistContractId
}

$outFile = Join-Path $deployDir "$Network.json"
$output | ConvertTo-Json -Depth 5 | Set-Content -Path $outFile -Encoding UTF8

Write-Host ""
Write-Host "Deploiement termine."
Write-Host "zk-verifier: $zkContractId"
Write-Host "heist      : $heistContractId"
Write-Host "fichier    : $outFile"
