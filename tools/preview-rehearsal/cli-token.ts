import { apiTokenScopes } from '#worker/api-tokens/scopes.ts'
import {
	describeFailure,
	postJson,
	type RehearsalSession,
} from './kody-session.ts'
import { type RehearsalOrigins } from './rehearsal-env.ts'

// Kept free of worker runtime imports so plain `node` scripts (the
// execution-context e2e) can mint preview CLI tokens.

const capabilityModule = [
	"import { kody } from 'kody:runtime'",
	'export default async function main(params) {',
	'\treturn kody[params.capability](params.input ?? {})',
	'}',
].join('\n')

export async function callCapability<T = Record<string, unknown>>(
	session: RehearsalSession,
	capability: string,
	input: Record<string, unknown> = {},
) {
	try {
		return (await session.execute(capabilityModule, {
			capability,
			input,
		})) as T
	} catch (error) {
		throw new Error(
			`${capability} as ${session.email} failed: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

export function readRecord(value: unknown, label: string) {
	if (!value || typeof value !== 'object') {
		throw new Error(`${label} returned ${JSON.stringify(value)}.`)
	}
	return value as Record<string, unknown>
}

export function readStringAt(
	value: unknown,
	path: Array<string>,
	label: string,
) {
	let current: unknown = value
	for (const key of path) {
		current = readRecord(current, label)[key]
	}
	if (typeof current !== 'string' || !current) {
		throw new Error(
			`${label} is missing ${path.join('.')}: ${JSON.stringify(value)}`,
		)
	}
	return current
}

/** An explicit token lifetime: an alias, or both TTLs in seconds. */
export type TokenLifetime =
	| { lifetime: 'short' | 'long' }
	| { idle_ttl_seconds: number; max_lifetime_seconds: number }

/**
 * The headless CLI login: `cliCredentialBootstrap` over MCP, then the same
 * `POST /v1/tokens/bootstrap/redeem` that `kody auth bootstrap` makes.
 */
export async function mintCliToken(
	session: RehearsalSession,
	origins: RehearsalOrigins,
	name: string,
	lifetime: TokenLifetime,
) {
	// cliCredentialBootstrap is MCP `api`-only; execute code refuses it.
	const bootstrap = await session.api('cliCredentialBootstrap', {
		name,
		scopes: apiTokenScopes,
		...lifetime,
	})
	const code = readStringAt(
		bootstrap,
		['bootstrap_code'],
		'cliCredentialBootstrap',
	)
	const redeemed = await postJson(`${origins.api}/v1/tokens/bootstrap/redeem`, {
		code,
		...lifetime,
	})
	if (redeemed.status !== 200 && redeemed.status !== 201) {
		throw new Error(describeFailure('/v1/tokens/bootstrap/redeem', redeemed))
	}
	return readStringAt(redeemed.body, ['token'], 'bootstrap redeem')
}
