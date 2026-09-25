#!/usr/bin/env bash
# DEV ONLY: creates and configures a brand-new demo restaurant (numbers start at 5001, all tables free).
# Used before browser end-to-end runs so every run starts from a clean restaurant.
set -euo pipefail
cd "$(dirname "$0")/../.."
export OWNER_EMAIL="owner.$(openssl rand -hex 3)@staff.example.com"
export OWNER_PASSWORD="$(openssl rand -hex 12)"
pnpm -s platform:create-restaurant --name "Chefelisha Restaurant (DEV)" --slug "bibiani-dev-$(openssl rand -hex 3)" \
  --owner-email "$OWNER_EMAIL" --owner-name "Owner" --start 5001 | tail -1
pnpm -s dev:configure-demo | tail -1
