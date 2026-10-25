#!/usr/bin/env bash
# Usage: cp .env.example .env && (fill in values) && fly auth login && scripts/deploy.sh <app-name>
set -euo pipefail
cd "$(dirname "$0")/.."
APP="${1:?usage: scripts/deploy.sh <fly-app-name>}"
[ -f .env ] || { echo ".env not found"; exit 1; }
set -a; . ./.env; set +a
for v in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET CF_ACCOUNT_ID CF_API_TOKEN; do
  [ -n "${!v:-}" ] || { echo "$v is empty in .env"; exit 1; }
done
BASE_URL="https://$APP.fly.dev"
fly status -a "$APP" >/dev/null 2>&1 || fly apps create "$APP"
fly volumes list -a "$APP" 2>/dev/null | grep -q memo_data || fly volumes create memo_data --size 1 --region nrt -a "$APP" -y
fly secrets set -a "$APP" --stage \
  GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" GOOGLE_CLIENT_SECRET="$GOOGLE_CLIENT_SECRET" \
  CF_ACCOUNT_ID="$CF_ACCOUNT_ID" CF_API_TOKEN="$CF_API_TOKEN" BASE_URL="$BASE_URL"
fly deploy -a "$APP" --ha=false
echo "Deployed: $BASE_URL"
echo "Google redirect URI to register: $BASE_URL/auth/google/callback"
