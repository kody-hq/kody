#!/usr/bin/env bash
# One-time setup of one variant, as run for this benchmark. Usage: bash setup.sh a|b|c REPO_CHECKOUT
# Creates ~/bench/wt-<v>, clean npm ci from that commit's lockfile, production build, local test D1 state, fixtures, and the local production server config.
set -euo pipefail
v=$1 repo=$2 here=$(cd "$(dirname "$0")" && pwd) wt=$HOME/bench/wt-$v
declare -A sha=([a]=3679094c5d6bcc75ff7c9b873930d1615886869f [b]=2894f12c99431f7e78816b502c24fdc72813dffc [c]=2894f12c99431f7e78816b502c24fdc72813dffc)
declare -A port=([a]=4101 [b]=4102 [c]=4103)
git -C "$repo" worktree add --detach "$wt" "${sha[$v]}"
cd "$wt"
[ "$v" = c ] && git apply "$here/c-vite-config.patch"
HUSKY=0 npm ci
if [ "$v" = c ]; then CLOUDFLARE_ENV=test npx vite build; else CLOUDFLARE_ENV=test npm run build; fi
CLOUDFLARE_ENV=test node tools/prepare-e2e-env.ts
CLOUDFLARE_ENV=test node tools/apply-local-app-migrations.ts
CLOUDFLARE_ENV=test node tools/seed-test-data.ts --local --env test --email me@kentcdodds.com --saved-packages 8
python3 "$here/fixtures/seed-sql.py" "$wt"
built=dist/server/wrangler.json; [ "$v" = a ] && built=dist/ssr/wrangler.json
node "$here/prepare-local-production.mjs" "$wt" "$built" "bench-$v" "${port[$v]}"
bash "$here/server.sh" start "$v"
node "$here/ready.mjs" "http://127.0.0.1:${port[$v]}"
node tools/control-kody.ts execute --origin "http://127.0.0.1:${port[$v]}" --email me@kentcdodds.com --code-file "$here/fixtures/memories-secrets-org.ts" --json
node "$here/fixtures/emails.mjs" "http://127.0.0.1:${port[$v]}"
bash "$here/server.sh" stop
