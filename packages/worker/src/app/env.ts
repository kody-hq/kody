import { parseSafe } from 'remix/data-schema'
import { isNonProductionRuntime } from '#app/deployment-env.ts'
import { EnvSchema } from '#worker/env-schema.ts'

// Env binding objects are stable per isolate; validate them once per identity
// instead of running schema validation on every call.
const validatedEnvs = new WeakSet<Env>()

/**
 * Validate required bindings and config once, then hand back the original env
 * object. Returning the schema's parsed output here would silently drop every
 * binding the schema does not model (REPO_SESSION, OAUTH_PROVIDER, ASSETS,
 * ...), which is why this returns `env` itself: the schema is a gate, not a
 * transform. Consumers normalize scalar values (trim etc.) at the point of
 * use.
 */
export function getEnv(env: Env): Env {
	if (!validatedEnvs.has(env)) {
		validateEnv(env)
		validatedEnvs.add(env)
	}
	return env
}

/**
 * Real production only. Local `npm run dev` copies production wrangler vars
 * (including `SENTRY_ENVIRONMENT=production`) into
 * `wrangler-local-dev.generated.json` but also sets `WRANGLER_IS_LOCAL_DEV=true`,
 * which `isNonProductionRuntime` treats as non-production so a fresh
 * `.env.example` can boot without Turnstile (#3939).
 */
function requiresProductionBootGuards(env: Env) {
	return env.SENTRY_ENVIRONMENT === 'production' && !isNonProductionRuntime(env)
}

function validateEnv(env: Env) {
	if (requiresProductionBootGuards(env) && !env.AUTH_RATE_LIMITER) {
		throw new Error(
			'Missing AUTH_RATE_LIMITER binding: production auth rate limiting must use the Cloudflare rate-limit binding, not the D1 fallback. Check the ratelimits block in packages/worker/wrangler.jsonc.',
		)
	}

	// Signup is always open; real production must not boot without Turnstile.
	// Local wrangler is not treated as production here (WRANGLER_IS_LOCAL_DEV).
	// Request-time protection also fails closed for unknown runtimes (unset
	// SENTRY_ENVIRONMENT) via isNonProductionRuntime in public-form-protection.ts.
	if (requiresProductionBootGuards(env)) {
		const siteKey = env.TURNSTILE_SITE_KEY?.trim()
		const secretKey = env.TURNSTILE_SECRET_KEY?.trim()
		if (!siteKey || !secretKey) {
			throw new Error(
				'Production requires TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY: signup is open and must not fail open without Turnstile.',
			)
		}
	}

	const result = parseSafe(EnvSchema, env)

	if (!result.success) {
		const message = result.issues
			.map((issue) => {
				const key =
					Array.isArray(issue.path) && issue.path.length > 0
						? issue.path.join('.')
						: 'env'
				return `${key}: ${issue.message}`
			})
			.join(', ')

		throw new Error(
			`Invalid environment variables: ${message}.\n\n💡 Tip: Check \`docs/contributing/environment-variables.md\` for details.`,
		)
	}
}
