#!/usr/bin/env bash
# start|stop|restart a variant's local production server. Usage: server.sh start a|b|c
set -u
here=$(cd "$(dirname "$0")" && pwd)
action=$1 v=${2:-a}
root=${BENCH_ROOT:-$HOME/bench}/wt-$v
declare -A ports=([a]=4101 [b]=4102 [c]=4103)
port=${ports[$v]}
stop() {
	for pid in $(pgrep -f "production-measurement-bench-.*/run.json" ; pgrep -x workerd); do kill "$pid" 2>/dev/null; done
	for _ in $(seq 1 50); do pgrep -x workerd >/dev/null || pgrep -f "serve-local-production" >/dev/null || break; sleep 0.2; done
	pkill -9 -x workerd 2>/dev/null; true
}
start() {
	(cd "$root" && exec setsid nohup node "$here/serve-local-production.mjs" ".tmp/production-measurement-bench-$v/run.json" > "${BENCH_LOG_DIR:-$HOME/bench}/serve-$v.log" 2>&1 < /dev/null) &
	disown
	for _ in $(seq 1 600); do
		curl -s -o /dev/null -m 5 "http://127.0.0.1:$port/health" -w '%{http_code}' 2>/dev/null | grep -q 200 && { echo "ready $v $port"; return 0; }
		sleep 0.1
	done
	echo "timeout $v"; return 1
}
case $action in
	start) start ;;
	stop) stop ;;
	restart) stop; start ;;
esac
