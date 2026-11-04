#!/usr/bin/env bash
# One soft-capped Workers unit attempt (#3763). The attempt budget runs from
# UNIT_JOB_START_EPOCH (this job's start, setup included), so a slow runner
# cannot burn the job timeout and leave Validate as workers=cancelled.
#
# GNU timeout exits 124 on the soft cap; 137 (--kill-after SIGKILL) counts as
# a budget timeout only after the soft deadline. A budget timeout writes
# outcome_<shard>=timeout so ☁️ Workers retry reruns the shard on a fresh
# runner with its own budget; retrying on the same runner repeats the same
# slow machine. Assertion failures write outcome_<shard>=fail and never retry.
# Keep ADR 0011 per-file isolation (do not disable isolate, warm DOs in
# Vitest setup files, or skip verify).
set -u
attempt_budget_seconds=780
kill_after_seconds=60
shard="${WORKERS_TEST_SHARD%%/*}"
attempt="${WORKERS_ATTEMPT:-1}"
elapsed=$(( $(date +%s) - UNIT_JOB_START_EPOCH ))
remaining=$((attempt_budget_seconds - elapsed))
if [ "$remaining" -lt 60 ]; then
	remaining=60
fi

attempt_started=$(date +%s)
if timeout --signal=TERM --kill-after="${kill_after_seconds}s" "${remaining}s" \
	npm run test:workers; then
	status=0
else
	status=$?
fi
attempt_elapsed=$(( $(date +%s) - attempt_started ))

outcome=fail
if [ "$status" -eq 0 ]; then
	outcome=pass
elif [ "$status" -eq 124 ]; then
	outcome=timeout
elif [ "$status" -eq 137 ] && [ "$attempt_elapsed" -ge "$remaining" ]; then
	outcome=timeout
fi
echo "outcome_${shard}=${outcome}" >> "${GITHUB_OUTPUT:-/dev/null}"

if [ "$outcome" = timeout ]; then
	runner="${RUNNER_NAME:-unknown runner}"
	if [ "$attempt" = 1 ]; then
		echo "::warning title=Workers ${WORKERS_TEST_SHARD} hit the attempt budget::Attempt 1 exceeded ≤${attempt_budget_seconds}s on ${runner} after ${attempt_elapsed}s mid-suite; ☁️ Workers retry reruns this shard on a fresh runner (#3763)."
	else
		echo "::error title=Workers ${WORKERS_TEST_SHARD} hit the attempt budget twice::Attempt ${attempt} exceeded ≤${attempt_budget_seconds}s on ${runner} after ${attempt_elapsed}s, on a second runner (#3763)."
	fi
fi
exit "$status"
