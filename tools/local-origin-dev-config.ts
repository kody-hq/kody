import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parseJsonc } from './ci/resource-utils.ts'

type JsonRecord = Record<string, unknown>

const localOriginDevVarKeys = [
	'WRANGLER_IS_LOCAL_DEV',
	'CLOUDFLARE_API_BASE_URL',
	'CLOUDFLARE_API_TOKEN',
	'CLOUDFLARE_ACCOUNT_ID',
	'CLOUDFLARE_API_SOURCE_SNAPSHOTS',
	'APP_BASE_URL',
	'USER_EMAIL_DOMAIN',
	'SYSTEM_EMAIL_DOMAIN',
] as const

/**
 * Non-secret process-env values Vite's Cloudflare plugin reads from Wrangler
 * `vars`, not from the Vite process environment, so they must be written into
 * `vars` for local `vite serve`. Secrets stay in `packages/worker/.env` /
 * `.dev.vars` next to the generated config.
 */
export function collectLocalOriginDevVars(
	env: NodeJS.ProcessEnv,
	port?: string,
) {
	const vars: Record<string, string> = {
		WRANGLER_IS_LOCAL_DEV: env.WRANGLER_IS_LOCAL_DEV?.trim() || 'true',
	}
	if (!env.APP_BASE_URL?.trim() && port) {
		vars.APP_BASE_URL = `http://localhost:${port}`
	}
	const skipLiveCloudflareToken = env.SKIP_CLOUDFLARE_MOCK?.trim() === '1'
	for (const key of localOriginDevVarKeys) {
		if (key === 'WRANGLER_IS_LOCAL_DEV') continue
		if (key === 'CLOUDFLARE_API_TOKEN' && skipLiveCloudflareToken) continue
		const value = env[key]?.trim()
		if (value) vars[key] = value
	}
	// Only the isolated E2E runner may inject a disposable provider simulator.
	if (
		env.KODY_E2E_WEB_SERVER === '1' &&
		env.CLOUDFLARE_ENV === 'test' &&
		env.KODY_E2E_STRIPE_TOKEN?.startsWith('sk_test_e2e_')
	) {
		const stripe = new URL(env.STRIPE_API_BASE_URL ?? '')
		if (stripe.protocol !== 'http:' || stripe.hostname !== '127.0.0.1')
			throw new Error('E2E Stripe must use loopback')
		vars.STRIPE_API_BASE_URL = stripe.origin
		vars.STRIPE_SECRET_KEY = env.KODY_E2E_STRIPE_TOKEN
	}
	return vars
}

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === 'object' ? (value as JsonRecord) : {}
}

/** Default generated config next to the committed wrangler jsonc. */
const localDevGeneratedConfigBasename = 'wrangler-local-dev.generated.json'

/**
 * E2E webServer writes a separate basename so a concurrent `dev:ensure` Vite
 * does not reload E2E-generated bindings (#3731 / Devin on #3745).
 */
const localE2eGeneratedConfigBasename = 'wrangler-local-e2e.generated.json'

export function localGeneratedConfigBasename(
	env: NodeJS.ProcessEnv = process.env,
) {
	return env.KODY_E2E_WEB_SERVER === '1'
		? localE2eGeneratedConfigBasename
		: localDevGeneratedConfigBasename
}

export async function writeLocalOriginDevConfig({
	originConfigPath,
	envName,
	vars,
	generatedBasename = localDevGeneratedConfigBasename,
	dropAlwaysRemoteBindings = [],
}: {
	originConfigPath: string
	envName: string
	vars: Record<string, string>
	generatedBasename?: string
	/**
	 * Always-remote Wrangler keys to omit from the selected env for local
	 * `vite serve` (same idea as `writeLocalSiblingDevConfig`). Production and
	 * preview deploy configs are untouched; only the generated local file
	 * drops these. Origin `ARTIFACTS` must be dropped so `packageSave` can
	 * fall through to the mock Artifacts REST client instead of failing with
	 * "Binding ARTIFACTS needs to be run remotely".
	 */
	dropAlwaysRemoteBindings?: ReadonlyArray<string>
}) {
	const sourceText = await readFile(originConfigPath, 'utf8')
	const config = parseJsonc<JsonRecord>(sourceText)
	const envs = config.env
	if (!envs || typeof envs !== 'object') {
		throw new Error(`${originConfigPath} is missing "env".`)
	}
	const originEnv = (envs as JsonRecord)[envName]
	if (!originEnv || typeof originEnv !== 'object') {
		throw new Error(`${originConfigPath} is missing "env.${envName}".`)
	}
	const envRecord = originEnv as JsonRecord
	for (const binding of dropAlwaysRemoteBindings) {
		delete envRecord[binding]
	}
	envRecord.vars = {
		...asRecord(envRecord.vars),
		...vars,
	}
	config.vars = {
		...asRecord(config.vars),
		...vars,
	}

	const outputPath = path.join(
		path.dirname(originConfigPath),
		generatedBasename,
	)
	await writeFile(outputPath, `${JSON.stringify(config, null, '\t')}\n`)
	return outputPath
}
