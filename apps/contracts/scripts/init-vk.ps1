param(
    [string]$Network = "testnet",
    [Parameter(Mandatory = $true)]
    [string]$Source,
    [string]$VerifierContractId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
$deployFile = Join-Path $repoRoot "apps\contracts\deployments\$Network.json"

if ([string]::IsNullOrWhiteSpace($VerifierContractId)) {
    if (Test-Path $deployFile) {
        $deploy = Get-Content $deployFile | ConvertFrom-Json
        $VerifierContractId = $deploy.zk_verifier_id
        Write-Host "Using verifier from deployment file: $VerifierContractId"
    } else {
        throw "VerifierContractId required. Provide it or ensure deployment file exists."
    }
}

# A dummy VK blob for the mock verifier (32 bytes of 0xAB)
$vkHex = "abababababababababababababababababababababababababababababababababab"

Write-Host "==> Setting VK on verifier $VerifierContractId ($Network)..."
$result = & stellar --quiet contract invoke `
    --network $Network `
    --source-account $Source `
    --id $VerifierContractId `
    -- `
    set_vk `
    --vk_json $vkHex

if ($LASTEXITCODE -ne 0) {
    throw "set_vk failed"
}

Write-Host "VK set successfully."
Write-Host "VK hash returned: $result"
Write-Host ""
Write-Host "Add this to your .env.local files:"
Write-Host "NEXT_PUBLIC_VK_HASH=$result"

# Also query to confirm
Write-Host ""
Write-Host "==> Verifying VK hash..."
$vkHash = & stellar --quiet contract invoke `
    --network $Network `
    --source-account $Source `
    --id $VerifierContractId `
    -- `
    get_vk_hash

Write-Host "Stored VK hash: $vkHash"
