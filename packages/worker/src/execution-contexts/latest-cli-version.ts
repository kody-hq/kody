const registryUrl = 'https://registry.npmjs.org/@kodycodes/cli/latest'
const freshMs = 60 * 60 * 1000
const failedMs = 5 * 60 * 1000

let cached: { version: string | null; until: number } | null = null
let inFlight: Promise<string | null> | null = null

/**
 * Newest published @kodycodes/cli, used to flag outdated daemons. Best effort:
 * a slow or failed lookup returns null and the UI just shows the version.
 */
export async function latestCliVersion(
	fetchImpl: typeof fetch = fetch,
	now = Date.now(),
): Promise<string | null> {
	if (cached && cached.until > now) return cached.version
	inFlight ??= (async () => {
		try {
			const response = await fetchImpl(registryUrl, {
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(2000),
			})
			if (!response.ok) throw new Error(`npm registry ${response.status}`)
			const body = (await response.json()) as { version?: unknown }
			const version =
				typeof body.version === 'string' && /^\d+\.\d+\.\d+/.test(body.version)
					? body.version
					: null
			cached = { version, until: now + (version ? freshMs : failedMs) }
			return version
		} catch {
			cached = { version: null, until: now + failedMs }
			return null
		} finally {
			inFlight = null
		}
	})()
	return await inFlight
}

export function resetLatestCliVersionCache() {
	cached = null
	inFlight = null
}
