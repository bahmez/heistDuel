param(
    [ValidateSet("testnet", "mainnet")]
    [string]$Network = "testnet",
    [Parameter(Mandatory = $true)]
    [string]$Source,
    [Parameter(Mandatory = $true)]
    [string]$GameHub,
    [string]$Admin,
    [string]$RustToolchain = "1.90.0-x86_64-pc-windows-msvc",
    [switch]$SkipBuild,
    # When set, upgrade the existing heist contract in-place instead of
    # deploying a new one.  The zk-verifier is never replaced in this mode
    # (its WASM and VK stay the same).
    [string]$UpgradeHeistId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if ($PSVersionTable.PSVersion.Major -ge 7) {
    $PSNativeCommandUseErrorActionPreference = $false
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Assert-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $Name"
    }
}

function Resolve-Address {
    param([string]$Value)
    if ($Value -match "^[GC][A-Z2-7]{55}$") { return $Value }
    $out = & stellar --quiet keys public-key $Value
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($out)) {
        throw "Cannot resolve address for '$Value'."
    }
    return $out.Trim()
}

function Invoke-Step {
    param([string]$Label, [scriptblock]$Action)
    Write-Host ""
    Write-Host "==> $Label"
    & $Action
}

function Get-ContractIdFromOutput {
    param([object]$Raw, [string]$Label)
    $text = (($Raw | ForEach-Object { "$_" }) -join "`n").Trim()
    $m = [regex]::Matches($text, "\bC[A-Z2-7]{55}\b")
    if ($m.Count -eq 0) { throw "Deployment $Label failed: no contract id in output." }
    return $m[$m.Count - 1].Value
}

function Get-QuotedValue {
    param([string]$Raw)
    # Strip surrounding quotes that the CLI sometimes adds
    return $Raw.Trim().Trim('"')
}

function Set-EnvVar {
    param([string]$FilePath, [string]$Key, [string]$Value)
    if (-not (Test-Path $FilePath)) { return }
    $content = Get-Content $FilePath -Raw
    if ($content -match "(?m)^$Key=") {
        $content = $content -replace "(?m)^$Key=.*", "$Key=$Value"
    } else {
        $content = $content.TrimEnd() + "`n$Key=$Value`n"
    }
    Set-Content -Path $FilePath -Value $content -NoNewline
    Write-Host "  Updated $Key in $(Split-Path $FilePath -Leaf)"
}

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

Assert-Command "stellar"
Assert-Command "cargo"

$repoRoot   = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$deployDir  = Join-Path $repoRoot "apps\contracts\deployments"
New-Item -ItemType Directory -Path $deployDir -Force | Out-Null

$networks = (& stellar --quiet network ls) -split "`r?`n" |
            ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
if ($networks -notcontains $Network) {
    throw "Network '$Network' not configured. Available: $($networks -join ', ')"
}

$gameHubAddress = Resolve-Address $GameHub
$adminAddress   = if ([string]::IsNullOrWhiteSpace($Admin)) {
    Resolve-Address $Source
} else {
    Resolve-Address $Admin
}

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

if (-not $SkipBuild) {
    Invoke-Step "Build zk-verifier wasm" {
        $env:RUSTUP_TOOLCHAIN = $RustToolchain
        & stellar contract build `
            --manifest-path (Join-Path $repoRoot "apps/contracts/zk-verifier/Cargo.toml")
        if ($LASTEXITCODE -ne 0) { throw "Build zk-verifier failed." }
    }
    Invoke-Step "Build heist wasm" {
        $env:RUSTUP_TOOLCHAIN = $RustToolchain
        & stellar contract build `
            --manifest-path (Join-Path $repoRoot "apps/contracts/heist/Cargo.toml")
        if ($LASTEXITCODE -ne 0) { throw "Build heist failed." }
    }
}

$zkWasm    = Join-Path $repoRoot "target\wasm32v1-none\release\zk_verifier.wasm"
$heistWasm = Join-Path $repoRoot "target\wasm32v1-none\release\heist.wasm"

if (-not (Test-Path $zkWasm))    { throw "WASM not found: $zkWasm" }
if (-not (Test-Path $heistWasm)) { throw "WASM not found: $heistWasm" }

# ---------------------------------------------------------------------------
# Deploy or upgrade
# ---------------------------------------------------------------------------

$zkContractId    = ""
$heistContractId = ""

if (-not [string]::IsNullOrWhiteSpace($UpgradeHeistId)) {
    # ---- Upgrade-only mode: keep same contract addresses ----------------
    $heistContractId = $UpgradeHeistId.Trim()

    # Read existing zk-verifier id from the deployment file
    $outFile = Join-Path $deployDir "$Network.json"
    if (Test-Path $outFile) {
        $existing = Get-Content $outFile | ConvertFrom-Json
        $zkContractId = $existing.zk_verifier_id
        Write-Host "Reusing zk-verifier: $zkContractId"
    } else {
        throw "-UpgradeHeistId requires an existing deployment file with the zk-verifier id."
    }

    Invoke-Step "Upload new heist WASM ($Network)" {
        $script:newWasmHash = (& stellar --quiet contract upload `
            --network $Network `
            --source-account $Source `
            --wasm $heistWasm) | Select-Object -Last 1
        $script:newWasmHash = Get-QuotedValue $script:newWasmHash
        Write-Host "  WASM hash: $($script:newWasmHash)"
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($script:newWasmHash)) {
            throw "WASM upload failed."
        }
    }

    Invoke-Step "Upgrade heist contract in-place ($Network)" {
        & stellar contract invoke `
            --network $Network `
            --source-account $Source `
            --id $heistContractId `
            -- upgrade `
            --new-wasm-hash $script:newWasmHash
        if ($LASTEXITCODE -ne 0) { throw "Upgrade failed." }
        Write-Host "  Contract $heistContractId upgraded to $($script:newWasmHash)"
    }

} else {
    # ---- Full deploy: new contract addresses ----------------------------
    Invoke-Step "Deploy zk-verifier ($Network)" {
        $zkRaw = & stellar --quiet contract deploy `
            --network $Network `
            --source-account $Source `
            --wasm $zkWasm `
            -- `
            --admin $adminAddress
        if ($LASTEXITCODE -ne 0) { throw "zk-verifier deployment failed." }
        $script:zkContractId = Get-ContractIdFromOutput -Raw $zkRaw -Label "zk-verifier"
    }
    $zkContractId = $script:zkContractId

    Invoke-Step "Deploy heist ($Network)" {
        $maxAttempts = 3
        for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
            $heistRaw = & stellar --quiet contract deploy `
                --network $Network `
                --source-account $Source `
                --wasm $heistWasm `
                -- `
                --admin $adminAddress `
                --game-hub $gameHubAddress `
                --verifier $zkContractId
            if ($LASTEXITCODE -eq 0) { break }
            if ($attempt -lt $maxAttempts) { Start-Sleep -Seconds 5 }
        }
        if ($LASTEXITCODE -ne 0) { throw "Heist deployment failed." }
        $script:heistContractId = Get-ContractIdFromOutput -Raw $heistRaw -Label "heist"
    }
    $heistContractId = $script:heistContractId
}

# ---------------------------------------------------------------------------
# Init VK (only when deploying fresh zk-verifier)
# ---------------------------------------------------------------------------

$vkHash = ""

if ([string]::IsNullOrWhiteSpace($UpgradeHeistId)) {
    Invoke-Step "Init VK on zk-verifier ($Network)" {
        # Dummy 32-byte VK for the mock verifier
        $vkHex = "abababababababababababababababababababababababababababababababababab"
        $raw = & stellar --quiet contract invoke `
            --network $Network `
            --source-account $Source `
            --id $zkContractId `
            -- set_vk `
            --vk_json $vkHex
        if ($LASTEXITCODE -ne 0) { throw "set_vk failed." }
        $script:vkHash = Get-QuotedValue ($raw | Select-Object -Last 1)
        Write-Host "  VK hash: $($script:vkHash)"
    }
    $vkHash = $script:vkHash
} else {
    # Reuse the VK hash from the existing deployment file
    $outFile = Join-Path $deployDir "$Network.json"
    if (Test-Path $outFile) {
        $existing = Get-Content $outFile | ConvertFrom-Json
        $vkHash = $existing.vk_hash
        Write-Host ""
        Write-Host "==> Reusing VK hash from existing deployment: $vkHash"
    }
}

# ---------------------------------------------------------------------------
# Update env files automatically
# ---------------------------------------------------------------------------

Invoke-Step "Update environment files" {
    $webEnv = Join-Path $repoRoot "apps\web\.env.local"
    $apiEnv = Join-Path $repoRoot "apps\api\.env"
    $pkgConst = Join-Path $repoRoot "packages\stellar\src\constants.ts"

    if (-not [string]::IsNullOrWhiteSpace($UpgradeHeistId)) {
        # Upgrade mode: only heist ID may have changed (it didn't — same address)
        # Nothing to update for env vars; wasm_hash tracked in deployment JSON only.
        Write-Host "  Upgrade mode — contract addresses unchanged, no env var update needed."
    } else {
        # Full deploy: update heist + verifier everywhere
        Set-EnvVar $webEnv "NEXT_PUBLIC_HEIST_CONTRACT_ID"       $heistContractId
        Set-EnvVar $webEnv "NEXT_PUBLIC_ZK_VERIFIER_CONTRACT_ID" $zkContractId
        if (-not [string]::IsNullOrWhiteSpace($vkHash)) {
            Set-EnvVar $webEnv "NEXT_PUBLIC_VK_HASH" $vkHash
        }

        Set-EnvVar $apiEnv "HEIST_CONTRACT_ID"       $heistContractId
        Set-EnvVar $apiEnv "ZK_VERIFIER_CONTRACT_ID" $zkContractId

        # Patch constants.ts
        if (Test-Path $pkgConst) {
            $c = Get-Content $pkgConst -Raw
            $c = $c -replace '("HEIST_CONTRACT_ID"\s*=\s*")[^"]*(")', "`${1}$heistContractId`${2}"
            $c = $c -replace 'HEIST_CONTRACT_ID\s*=\s*\n\s*"[^"]*"', "HEIST_CONTRACT_ID =`n  `"$heistContractId`""
            $c = $c -replace '(?m)(export const HEIST_CONTRACT_ID\s*=\s*\n?\s*)"[^"]+"', "`${1}`"$heistContractId`""
            $c = $c -replace '(?m)(export const ZK_VERIFIER_CONTRACT_ID\s*=\s*\n?\s*)"[^"]+"', "`${1}`"$zkContractId`""
            Set-Content -Path $pkgConst -Value $c -NoNewline
            Write-Host "  Updated constants.ts"
        }
    }
}

# ---------------------------------------------------------------------------
# Save deployment record
# ---------------------------------------------------------------------------

$outFile = Join-Path $deployDir "$Network.json"
$record = [ordered]@{
    deployed_at_utc  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    network          = $Network
    source           = $Source
    admin            = $adminAddress
    game_hub         = $gameHubAddress
    zk_verifier_id   = $zkContractId
    heist_id         = $heistContractId
    vk_hash          = $vkHash
}
$record | ConvertTo-Json -Depth 5 | Set-Content -Path $outFile -Encoding UTF8

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "========================================"
Write-Host "Deployment complete"
Write-Host "========================================"
Write-Host "zk-verifier : $zkContractId"
Write-Host "heist       : $heistContractId"
if (-not [string]::IsNullOrWhiteSpace($vkHash)) {
    Write-Host "VK hash     : $vkHash"
}
Write-Host "Record saved: $outFile"
Write-Host ""
Write-Host "Restart the dev server to apply the changes."
