/**
 * Published blog post path segments under `/blog/:slug`.
 *
 * Kept client-safe (no markdown imports) so public-path allowlists can fail
 * closed for unknown slugs. The catalog in `#worker/blog/catalog.ts` owns the
 * post bodies; its node test asserts every catalog slug appears here.
 */
export const blogPostSlugs = [
	'early-kody-users',
	'your-assistants-home',
	'gateways-connect-homes-accumulate',
	'the-assistant-that-cant-leak-your-keychain',
	'zero-inference-calls',
	'every-install-is-a-fork-you-own',
	'the-automations-you-never-built',
	'self-service-means-ownership',
	'openclaw-2-needs-a-home',
	'how-to-turn-agent-work-into-software-you-own',
	'kody-weekly-2026-03-20',
] as const
