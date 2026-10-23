---
name: ship-pr
description: >
  Babysit a PR: iterate with AI reviewers and CI until green, get it ready,
  optionally squash-merge as Kody and watch the publish, then send a Discord
  summary. Medium risk waits for AI reviewer(s) and addresses valid feedback.
  Use when a pull request needs to be shepherded to done.
---

# Ship PR

This is the kody `ship-pr` skill, scoped to `@kodycodes/cli`.

## Risk → merge authority

Self-assess; user policy overrides.

**Kent's standing policy (2026-08-08):** auto-ship (squash-merge + verify
publish) once AI reviewer feedback is addressed and CI is green, unless **high**
risk. High risk still parks ready-for-review unless merge authority was granted
explicitly.

- **Low** — green CI; nits ignorable; squash-merge when policy allows.
- **Medium** — wait for AI reviewer(s); address **valid** feedback (ignore
  insignificant nits / already-fixed / wrong); then merge when policy allows.
- **High** — leave ready-for-review unless the user granted merge authority.

## AI reviewers

Prefer **Cursor Bugbot** (`Cursor Bugbot` check / `cursor[bot]` review
comments). Trigger with `bugbot run` or `@cursor review` on the PR if it has not
started.

**CodeRabbit:** if it is rate-limited, errored, or otherwise unavailable, **do
not wait** on it for low/medium risk — proceed with Bugbot + CI. Only wait on
CodeRabbit when the change is **high** risk (or the user explicitly asks).

## Loop

1. Mark ready — `kody:@kentcdodds/github/pr/set-review-status`
   `{ prUrl, status: 'ready' }` (or owner/repo/prNumber).
2. Wait for CI: `gh pr checks` (or compose `loop-on-ci` / `fix-ci`). Cursor:
   prefer a one-shot `subscribe_timer` over polling. Without one, poll with a
   plain `sleep` of 60 to 120 seconds, cap the total wait (about 45 minutes),
   then report the stuck state instead of waiting forever.
3. Fix failures; for **medium+**, wait on AI reviewer(s) (Bugbot first; see
   above for CodeRabbit) and address valid feedback. Rebase only when actually
   unmergeable. Local gate is `npm run validate`. If the change touches login /
   MCP protocol, also smoke `whoami`, `search`, and `execute` against
   `https://kody.codes/mcp`.
4. Green + (medium+: valid feedback cleared) → break.
5. Push → repeat.

## Gates ≠ CI

Blocked on a release / trusted-publishing / calendar gate → **end the run** and
schedule a wake (Kody `job_schedule` + Cursor `createRun`, or your runtime's own
wake, such as Devin `sendMessage`). With no wake mechanism, park and report the
gate. Don't sleep-poll or code-thrash an intentional time window.

## Merge / publish

When policy + risk allow: squash-merge via `kody:@kentcdodds/github/pr/merge`
`{ prUrl, mergeMethod: 'squash' }`. `main` conventional commits publish
`@kodycodes/cli` through semantic-release. Useful: `pr/get-checks`, `request`,
`graphql` on the same package.

## Done → Discord

Always summarize (merged or not) with agent / PR / CI / publish links. Name the
agent truthfully: a Cursor agent link only from a real `bc-` id; Codex, Claude,
Devin, or other agents name themselves and link only a real session URL. Never
fabricate a Cursor id or model.

```javascript
import postMessage from 'kody:@kentcdodds/discord/post-message'

export default async function main() {
	return postMessage({
		channelId: '1491568683737157683',
		content: '…summary with links…',
	})
}
```
