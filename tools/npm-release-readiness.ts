import { setTimeout } from 'node:timers/promises'

export async function waitForNpmPackage(
	name: string,
	version: string,
	options: {
		fetch?: typeof fetch
		sleep?: (ms: number) => Promise<unknown>
		now?: () => number
		timeoutMs?: number
		intervalMs?: number
	} = {},
) {
	const fetchFn = options.fetch ?? fetch
	const sleep = options.sleep ?? setTimeout
	const now = options.now ?? Date.now
	const deadline = now() + (options.timeoutMs ?? 35 * 60_000)
	const headers = { 'cache-control': 'no-cache, no-store', pragma: 'no-cache' }
	while (now() < deadline) {
		const signal = AbortSignal.timeout(
			Math.max(1, Math.min(30_000, deadline - now())),
		)
		try {
			const url = new URL(
				`https://registry.npmjs.org/${encodeURIComponent(name)}`,
			)
			url.searchParams.set('_', String(now()))
			const response = await fetchFn(url, { headers, signal })
			if (response.ok) {
				const metadata = (await response.json()) as {
					versions?: Record<string, { dist?: { tarball?: string } }>
				}
				const tarball = metadata.versions?.[version]?.dist?.tarball
				if (tarball) {
					const tarballUrl = new URL(tarball)
					tarballUrl.searchParams.set('_', String(now()))
					const download = await fetchFn(tarballUrl, { headers, signal })
					if (download.ok) {
						for await (const chunk of download.body ?? []) {
							void chunk
						}
						return
					}
					await download.body?.cancel()
				}
			} else {
				await response.body?.cancel()
			}
		} catch {
			// Registry and CDN failures can be transient while npm processes a release.
		}
		const remaining = deadline - now()
		if (remaining > 0)
			await sleep(Math.min(options.intervalMs ?? 15_000, remaining))
	}
	throw new Error(
		`Timed out waiting for ${name}@${version} to resolve on npm (metadata and tarball).`,
	)
}
