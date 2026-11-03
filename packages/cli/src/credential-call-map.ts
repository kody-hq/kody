/**
 * CLI `--credential` picks for ADR 0068 call maps.
 *
 * Flag shapes (repeatable):
 * - `--credential github=work`
 * - `--credential x=org:work` / `--credential x=personal:work`
 * - `--credential github=` → none on purpose (`[]`)
 *
 * Empty + named pick for the same key is a local error. Repeated named picks
 * become an array. The map is sent as the CapabilityProxy call's top-level
 * `credentials` field (never inside `args`), or as MCP `execute` `credentials`.
 */

const credentialCallMapFeature = 'credential-call-map'

const credentialCallMapLimits = {
	maxKeys: 32,
	maxPicksPerKey: 16,
	maxTextLength: 100,
} as const

const keyPattern = new RegExp(
	`^[A-Za-z0-9][A-Za-z0-9._-]{0,${credentialCallMapLimits.maxTextLength - 1}}$`,
)

export type CredentialPickInput =
	| string
	| { name: string; scope?: 'org' | 'personal' }

/** JSON shape accepted by CapabilityProxy / MCP execute `credentials`. */
export type CredentialCallMapInput = Record<
	string,
	CredentialPickInput | Array<CredentialPickInput>
>

export type CredentialClientErrorBody = {
	code?: string
	message?: string
	retryWith?: Array<unknown>
	options?: Array<unknown>
	possibleMatches?: Array<unknown>
}

export function parseCredentialFlag(raw: string): {
	key: string
	/** Empty array means none on purpose (`key=`). */
	picks: Array<CredentialPickInput>
	empty: boolean
} {
	const eq = raw.indexOf('=')
	if (eq <= 0) {
		throw new Error(
			`Invalid --credential ${JSON.stringify(raw)}. Use --credential key=name, --credential key=org:name, or --credential key= for none.`,
		)
	}
	const key = raw.slice(0, eq)
	const value = raw.slice(eq + 1)
	assertCredentialMapKey(key)
	if (value === '') return { key, picks: [], empty: true }
	return { key, picks: [parseCredentialPick(value)], empty: false }
}

export function parseCredentialFlags(
	flags: ReadonlyArray<string> | undefined,
): CredentialCallMapInput | undefined {
	if (!flags || flags.length === 0) return undefined
	const collected = new Map<string, Array<CredentialPickInput>>()
	const emptyKeys = new Set<string>()
	for (const flag of flags) {
		const { key, picks, empty } = parseCredentialFlag(flag)
		if (empty) {
			if ((collected.get(key)?.length ?? 0) > 0) {
				throw new Error(
					`Invalid --credential for ${key}: cannot combine an empty pick (none) with a named pick.`,
				)
			}
			emptyKeys.add(key)
			collected.set(key, [])
			continue
		}
		if (emptyKeys.has(key)) {
			throw new Error(
				`Invalid --credential for ${key}: cannot combine an empty pick (none) with a named pick.`,
			)
		}
		const existing = collected.get(key) ?? []
		existing.push(...picks)
		if (existing.length > credentialCallMapLimits.maxPicksPerKey) {
			throw new Error(
				`A credentials map takes at most ${credentialCallMapLimits.maxPicksPerKey} picks per key (${key}).`,
			)
		}
		collected.set(key, existing)
	}
	if (collected.size > credentialCallMapLimits.maxKeys) {
		throw new Error(
			`A credentials map takes at most ${credentialCallMapLimits.maxKeys} keys.`,
		)
	}
	const map: CredentialCallMapInput = {}
	for (const [key, picks] of collected) {
		if (emptyKeys.has(key)) {
			map[key] = []
			continue
		}
		map[key] = picks.length === 1 ? picks[0]! : picks
	}
	return map
}

function parseCredentialPick(value: string): CredentialPickInput {
	// Trim before scope detection so ` org:work` is org-scoped `work`, not a
	// plain name `org:work` (Bugbot / ADR 0068 name-after-trim).
	const trimmed = value.trim()
	const colon = trimmed.indexOf(':')
	if (colon > 0) {
		const prefix = trimmed.slice(0, colon)
		if (prefix === 'org' || prefix === 'personal') {
			const name = trimmed.slice(colon + 1).trim()
			assertCredentialText(name, 'credential name')
			return { name, scope: prefix }
		}
	}
	assertCredentialText(trimmed, 'credential name')
	return trimmed
}

function assertCredentialMapKey(key: string): void {
	if (!keyPattern.test(key)) {
		throw new Error(
			`Invalid --credential key ${JSON.stringify(key)}. A key starts with a letter or digit and uses letters, digits, dots, underscores, or hyphens (max ${credentialCallMapLimits.maxTextLength}).`,
		)
	}
}

function assertCredentialText(value: string, label: string): void {
	if (!value || value.length > credentialCallMapLimits.maxTextLength) {
		throw new Error(
			`Invalid --credential ${label} ${JSON.stringify(value)}. Use 1–${credentialCallMapLimits.maxTextLength} characters.`,
		)
	}
}

export function sessionSupportsCredentialCallMap(
	features: ReadonlyArray<string> | undefined,
): boolean {
	return Array.isArray(features) && features.includes(credentialCallMapFeature)
}

export function missingCredentialCallMapFeatureMessage(): string {
	return 'This Kody host does not support --credential yet.'
}

/** Format one pick as a CLI `--credential` suggestion. */
export function formatCredentialFlagSuggestion(
	key: string,
	pick: unknown,
): string | null {
	if (typeof pick === 'string') {
		return `--credential ${key}=${pick}`
	}
	if (Array.isArray(pick)) {
		if (pick.length === 0) return `--credential ${key}=`
		return pick
			.map((entry) => formatCredentialFlagSuggestion(key, entry))
			.filter((line): line is string => line !== null)
			.join('\n')
	}
	if (pick && typeof pick === 'object') {
		const record = pick as { name?: unknown; scope?: unknown }
		if (typeof record.name !== 'string' || !record.name) return null
		if (record.scope === 'org' || record.scope === 'personal') {
			return `--credential ${key}=${record.scope}:${record.name}`
		}
		return `--credential ${key}=${record.name}`
	}
	return null
}

/**
 * Print code + message, and render `retryWith[].credentials` as `--credential`
 * suggestions (ADR 0068).
 */
export function formatCredentialClientError(
	error: CredentialClientErrorBody,
): string {
	const code =
		typeof error.code === 'string' && error.code
			? error.code
			: 'credential_error'
	const message =
		typeof error.message === 'string' && error.message
			? error.message
			: 'The credential could not be used.'
	const lines = [`${code}: ${message}`]
	const retries = Array.isArray(error.retryWith) ? error.retryWith : []
	for (const entry of retries) {
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
		const credentials = (entry as { credentials?: unknown }).credentials
		if (
			!credentials ||
			typeof credentials !== 'object' ||
			Array.isArray(credentials)
		) {
			continue
		}
		for (const [key, pick] of Object.entries(
			credentials as Record<string, unknown>,
		)) {
			const suggestion = formatCredentialFlagSuggestion(key, pick)
			if (suggestion) {
				for (const line of suggestion.split('\n')) {
					lines.push(`  retry: ${line}`)
				}
			}
		}
	}
	return lines.join('\n')
}
