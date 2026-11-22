#!/usr/bin/env bash
# One measurement round for one variant against its local production server.
# Usage: run-variant.sh a|b|c ROUND [SCALE]
#   SCALE=1 (default) is half the target n per round; run-all.sh runs two rounds per variant (a b c, then c b a).
#   SCALE=2 gives the full target n in a single round (one command per variant reproduction).
set -u -o pipefail
here=$(cd "$(dirname "$0")" && pwd)
v=$1 round=$2 scale=${3:-1}
case $v in a) port=4101;; b) port=4102;; c) port=4103;; esac
origin=http://127.0.0.1:$port
res=$here/../results
mkdir -p "$res"/{parity,ttfb,assets,hydration,navigation,lighthouse/round$round,coldstart,warmup}
log() { echo "$(date +%H:%M:%S) $v r$round $*" | tee -a "$res/run-log.txt"; }
cd "$here"
bash server.sh restart "$v" || { log "server failed"; exit 1; }
node ready.mjs "$origin" | tee -a "$res/run-log.txt" || { log "not ready"; exit 1; }
log start
node parity.mjs "$origin" "$v" "$res/parity/parity-$v-r$round.json" || log "parity failed"
node assets.mjs "$origin" "$v" "$res/warmup/assets-warmup-$v-r$round.json" 1 || log "warmup failed"
node ttfb.mjs "$origin" "$v" "$res/ttfb/ttfb-$v-r$round.json" $((25*scale)) 5 || log "ttfb failed"
[ -n "${SKIP_ASSETS:-}" ] || node assets.mjs "$origin" "$v" "$res/assets/assets-$v-r$round.json" $((10*scale)) || log "assets failed"
node hydration.mjs "$origin" "$v" "$res/hydration/hydration-$v-cpu1-r$round.json" $((10*scale)) 1 || log "hydration cpu1 failed"
node hydration.mjs "$origin" "$v" "$res/hydration/hydration-$v-cpu4-r$round.json" $((5*scale)) 4 || log "hydration cpu4 failed"
for cfg in "1 0" "1 300" "4 0" "4 300"; do
	set -- $cfg
	node navigation.mjs "$origin" "$v" "$res/navigation/nav-$v-cpu$1-hover$2-r$round.json" $((10*scale)) "$1" "$2" || log "navigation cpu$1 hover$2 failed"
done
[ -n "${SKIP_LH:-}" ] || node lighthouse.mjs "$origin" "$v" "$res/lighthouse/round$round" $(( round == 1 ? 3*scale : 2*scale )) || log "lighthouse failed"
node coldstart.mjs "$v" "$res/coldstart/coldstart-$v-r$round.json" $((5*scale)) || log "coldstart failed"
log done
