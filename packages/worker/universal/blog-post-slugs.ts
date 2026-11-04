/**
 * Published blog post path segments under `/blog/:slug`.
 *
 * Kept client-safe (no markdown imports) so public-path allowlists can fail
 * closed for unknown slugs. The catalog in `#worker/blog/catalog.ts` owns the
 * post bodies; its node test asserts every catalog slug appears here.
 */
export const blogPostSlugs = [
	'ai-agent-audit-log-for-production-access',
	'ai-agent-credentials-guide-for-team-leads',
	'ai-agent-github-access-without-your-token',
	'ai-agent-guardrails-for-teams',
	'ai-agent-skills-vs-packages',
	'ai-tooling-for-engineering-teams-hidden-cost',
	'avoid-ai-assistant-lock-in',
	'bring-your-own-key-for-shared-team-tools',
	'claude-code-cursor-and-codex-shared-credentials',
	'early-kody-users',
	'engineers-are-handing-private-keys-to-ai-agents',
	'every-install-is-a-fork-you-own',
	'gateways-connect-homes-accumulate',
	'how-to-roll-out-ai-agents-to-your-team',
	'how-to-turn-agent-work-into-software-you-own',
	'internal-tools-built-with-ai-team-credentials',
	'kody-weekly-2026-03-20',
	'least-privilege-for-ai-agents',
	'mcp-security-checklist-for-engineering-managers',
	'openclaw-2-needs-a-home',
	'revoke-ai-agent-access',
	'self-service-means-ownership',
	'share-ai-workflows-with-your-team',
	'team-ai-workflows-when-someone-quits',
	'the-assistant-that-cant-leak-your-keychain',
	'the-automations-you-never-built',
	'where-to-store-api-keys-for-ai-agents',
	'why-ai-agent-costs-keep-growing',
	'why-aws-lambda-breaks-down-for-ai-agent-teams',
	'your-assistants-home',
	'zero-inference-calls',
] as const
