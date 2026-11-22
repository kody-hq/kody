#!/usr/bin/env bash
# Metric 2a: worker bundle sizes (commit's check-worker-startup-bundles.ts, kept outdir, gzip) and startup CPU
# (startup-samples.ts on the commit's own tools), passes in order a b c c b a, 5 samples per pass -> n=10.
set -u
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-$here/../results/worker}
mkdir -p "$out"
bash "$here/server.sh" stop
bash "$here/worker-gzip.sh" "$out"
pass=0
for v in a b c c b a; do
	pass=$((pass+1))
	(cd "$HOME/bench/wt-$v" && node "$here/startup-samples.ts" "$v" "$pass" "$out/startup-samples-$v-pass$pass.json" 5) >> "$out/startup-samples.log" 2>&1 || echo "startup-samples $v pass$pass exit $?" >> "$out/startup-samples.log"
done
