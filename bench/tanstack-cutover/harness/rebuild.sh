#!/usr/bin/env bash
# Production build of each variant from its own worktree. Needed after worker.sh because the commit's
# startup-bundle check rebuilds repo-root dist/ with its own startup-check build, which the local server cannot serve.
set -u
for v in ${@:-a b c}; do
	cd "$HOME/bench/wt-$v"
	if [ "$v" = c ]; then CLOUDFLARE_ENV=test npx vite build > "$HOME/bench/build-$v.log" 2>&1
	else CLOUDFLARE_ENV=test npm run build > "$HOME/bench/build-$v.log" 2>&1; fi
	echo "build $v exit $?"
done
