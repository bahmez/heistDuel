#!/bin/bash
# Generate the UltraHonk verification key for the turn_validity Noir circuit.
#
# Requires Docker with Ubuntu 24.04 (GLIBC 2.39) and ~8 GB RAM.
# The compiled circuit must already exist at:
#   apps/circuits/turn_validity/target/turn_validity.json
# Run `nargo compile` first if needed (see README.md).
#
# Usage (from repo root):
#   docker run --rm --memory=8g \
#     -v "$(pwd):/workspace" \
#     ubuntu:24.04 bash /workspace/docker_gen_vk.sh

set -e

CIRCUIT_JSON="/workspace/apps/circuits/turn_validity/target/turn_validity.json"
VK_OUT_DIR="/workspace/apps/circuits/turn_validity/target/vk"

echo "==> Installing curl..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y curl 2>&1 | tail -3

echo "==> System info:"
ldd --version | head -1
nproc
free -h

echo "==> Checking circuit exists..."
ls -lh "$CIRCUIT_JSON"

echo "==> Downloading bb 3.0.0-nightly.20251104..."
# NOTE: The correct GitHub tag is v3.0.0-nightly.20251104 (without 'aztec-packages-' prefix)
# and the asset is barretenberg-amd64-linux.tar.gz (not barretenberg-x86_64-linux-gnu.tar.gz)
BB_URL="https://github.com/AztecProtocol/aztec-packages/releases/download/v3.0.0-nightly.20251104/barretenberg-amd64-linux.tar.gz"
mkdir -p /root/.bb
curl -fsSL "$BB_URL" -o /root/.bb/bb.tar.gz
cd /root/.bb && tar -xzf bb.tar.gz && rm bb.tar.gz && chmod +x ./bb

echo "==> bb version: $(/root/.bb/bb --version)"

echo "==> Generating VK (this takes ~90 seconds and ~7 GB RAM)..."
/root/.bb/bb write_vk \
  -b "$CIRCUIT_JSON" \
  -o "$VK_OUT_DIR"

echo "==> VK generated:"
ls -lh "$VK_OUT_DIR/"

echo ""
echo "Next step — upload the VK to the deployed zk-verifier:"
echo "  cd apps/contracts"
echo "  npx tsx scripts/deploy.ts --update-vk-id <ZK_VERIFIER_CONTRACT_ID>"
