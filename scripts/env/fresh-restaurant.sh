#!/usr/bin/env bash
# Creates and configures a fresh demo restaurant in the given environment, through the deployed admin API.
#   scripts/env/fresh-restaurant.sh <env-file> <api-url> <accounts-file>
set -euo pipefail
cd "$(dirname "$0")/../.."
ENV_FILE="$1"; API="$2"; ACCOUNTS="$3"
export OWNER_EMAIL="owner.$(openssl rand -hex 3)@staff.example.com"
export OWNER_PASSWORD="$(openssl rand -hex 12)"
npx tsx --env-file="$ENV_FILE" scripts/platform/create-restaurant.ts --name "Chefelisha Restaurant (test)" \
  --slug "bibiani-test-$(openssl rand -hex 3)" --owner-email "$OWNER_EMAIL" --owner-name "Owner" --start 5001 | tail -1
API_URL="$API" ACCOUNTS_FILE="$ACCOUNTS" npx tsx --env-file="$ENV_FILE" scripts/dev/configure-demo.ts | tail -1
