#!/usr/bin/env bash
# Full benchmark: worker checks, then two interleaved rounds (a b c, then c b a).
set -u
here=$(cd "$(dirname "$0")" && pwd)
bash "$here/worker.sh"
bash "$here/rebuild.sh"
for v in a b c; do bash "$here/run-variant.sh" "$v" 1; done
for v in c b a; do bash "$here/run-variant.sh" "$v" 2; done
bash "$here/server.sh" stop
node "$here/stats.mjs"
