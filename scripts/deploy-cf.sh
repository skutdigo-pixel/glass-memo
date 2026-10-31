#!/usr/bin/env bash
# One-command deploy to Cloudflare Workers (free plan, no credit card).
# Prereqs: `npx wrangler login` once, and .secrets.local containing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.
set -euo pipefail
cd "$(dirname "$0")/.."
W="npx wrangler"
[ -f .secrets.local ] || { echo ".secrets.local not found"; exit 1; }
set -a; . ./.secrets.local; set +a
unset CF_API_TOKEN CLOUDFLARE_API_TOKEN CF_ACCOUNT_ID   # use the OAuth login, not the Workers-AI-only token
: "${GOOGLE_CLIENT_ID:?}"; : "${GOOGLE_CLIENT_SECRET:?}"

if grep -q REPLACE_WITH_D1_ID wrangler.toml; then
  out=$($W d1 create glass-memo 2>&1) || true
  id=$(echo "$out" | grep -Eo '[0-9a-f]{8}-[0-9a-f-]{27}' | head -1)
  [ -n "$id" ] || id=$($W d1 list --json | python3 -c "import sys,json;print(next(d['uuid'] for d in json.load(sys.stdin) if d['name']=='glass-memo'))")
  sed -i '' "s/REPLACE_WITH_D1_ID/$id/" wrangler.toml
fi
if grep -q REPLACE_WITH_KV_ID wrangler.toml; then
  out=$($W kv namespace create MEDIA 2>&1) || true
  id=$(echo "$out" | grep -Eo '[0-9a-f]{32}' | head -1)
  [ -n "$id" ] || id=$($W kv namespace list | python3 -c "import sys,json;print(next(d['id'] for d in json.load(sys.stdin) if d['title'].endswith('MEDIA')))")
  sed -i '' "s/REPLACE_WITH_KV_ID/$id/" wrangler.toml
fi

$W d1 execute glass-memo --remote --yes --file=schema.sql
for f in private/media/*.jpg; do
  $W kv key put --binding=MEDIA --remote "$(basename "$f")" --path="$f"
done
$W deploy
printf '%s' "$GOOGLE_CLIENT_ID" | $W secret put GOOGLE_CLIENT_ID
printf '%s' "$GOOGLE_CLIENT_SECRET" | $W secret put GOOGLE_CLIENT_SECRET
echo "Done. Register https://<worker-host>/auth/google/callback as an authorized redirect URI in Google Cloud."
