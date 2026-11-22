import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'

const registryUrl = 'https://registry.npmjs.org/@kodycodes/cli/latest'
const freshMs = 60 * 60 * 1000
const failedMs = 5 * 60 * 1000

let cached: { version: string | null; until: number } | null = null
const lookups = new PromiseLruCache<string | null>({ retainSettled: false })

/**
 * Newest published @kodycodes/cli, used to flag outdated daemons. Best effort:
 * a slow or failed lookup returns null and the UI just shows the version.
 */
export async function latestCliVersion(
	fetchImpl: typeof fetch = fetch,
	now = Date.now(),
): Promise<string | null> {
	if (cached && cached.until > now) return cached.version
	return await lookups.getOrCreate({
		cacheKey: registryUrl,
		create: async () => {
			try {
				const response = await fetchImpl(registryUrl, {
					headers: { accept: 'application/json' },
					signal: AbortSignal.timeout(2000),
				})
				if (!response.ok) throw new Error(`npm registry ${response.status}`)
				const body = (await response.json()) as { version?: unknown }
				const version =
					typeof body.version === 'string' &&
					/^\d+\.\d+\.\d+/.test(body.version)
						? body.version
						: null
				cached = { version, until: now + (version ? freshMs : failedMs) }
				return version
			} catch {
				cached = { version: null, until: now + failedMs }
				return null
			}
		},
	})
}

export function resetLatestCliVersionCache() {
	cached = null
	lookups.clear()
}
