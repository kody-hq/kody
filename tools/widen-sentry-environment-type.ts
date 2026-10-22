/**
 * Wrangler `--env=production` pins `SENTRY_ENVIRONMENT` to the `"production"`
 * literal. Preview and test runtimes use other values, and worker tests need
 * `Pick<Env, 'SENTRY_ENVIRONMENT'>` to accept those without a hand-rolled type.
 */
export function widenSentryEnvironmentType(source: string) {
	return source.replaceAll(
		'SENTRY_ENVIRONMENT: "production";',
		'SENTRY_ENVIRONMENT: string;',
	)
}
