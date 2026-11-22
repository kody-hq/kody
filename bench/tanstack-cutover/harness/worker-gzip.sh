#!/usr/bin/env bash
# Metric 2a sizes: keep each commit's own startup bundle outdir and record raw + gzip (level 9) of every emitted .js/.wasm.
set -u
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-$here/../results/worker}
for v in a b c; do
	cd "$HOME/bench/wt-$v"
	rm -rf .tmp/startup-bundles-keep
	node tools/check-worker-startup-bundles.ts --keep-outdir .tmp/startup-bundles-keep > "$out/bundles-keep-$v.txt" 2>&1
	echo "keep $v exit $?" >> "$out/exit-codes.txt"
	node -e "
const fs=require('fs'),path=require('path'),zlib=require('zlib');const root=process.argv[1];const rows=[];
const walk=(d)=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]);
for(const f of walk(root)){if(!/\.(js|mjs|wasm)$/.test(f))continue;const b=fs.readFileSync(f);rows.push({file:path.relative(root,f),raw:b.length,gzip:zlib.gzipSync(b,{level:9}).length})}
fs.writeFileSync(process.argv[2],JSON.stringify({variant:process.argv[3],files:rows},null,1))" .tmp/startup-bundles-keep "$out/worker-files-$v.json" "$v"
done
