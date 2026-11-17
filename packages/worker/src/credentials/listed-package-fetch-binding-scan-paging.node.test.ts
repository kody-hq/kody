import { expect, test, vi } from 'vitest'

const stored = vi.hoisted(() => ({
	rowsBySource: {} as Record<string, Array<string>>,
	packages: [] as Array<{ id: string; userId: string; sourceId: string }>,
	failingSourceId: null as string | null,
}))

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	hasPublishedRuntimeArtifacts: () => true,
	loadPublishedSourceSnapshot: async () => null,
	readPublishedBundleArtifact: async ({ kvKey }: { kvKey: string }) => ({
		kind: 'module',
		modules: {
			'bundle.js': kvKey.endsWith('read')
				? 'export const a = () => globalThis.fetch(url)'
				: 'export const a = () => fetch(url)',
		},
	}),
}))
vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: async (_db: unknown, id: string) => {
		if (id === stored.failingSourceId) throw new Error('read failed')
		return { id, user_id: 'owner', published_commit: 'commit' }
	},
}))
vi.mock(
	'#worker/package-runtime/published-importable-artifact-backfill.ts',
	() => ({
		listCandidatePackages: async (input: {
			afterId: string | null
			limit: number
		}) => {
			const rest = stored.packages.filter(
				(entry) => !input.afterId || entry.id > input.afterId,
			)
			const packages = rest.slice(0, input.limit)
			return {
				packages,
				nextCursor:
					rest.length > input.limit ? (packages.at(-1)?.id ?? null) : null,
			}
		},
	}),
)

const { runListedPackageFetchBindingScan } =
	await import('./listed-package-fetch-binding-scan.ts')

function makeEnv() {
	return {
		APP_DB: {
			prepare: (sql: string) => ({
				bind: (...args: Array<unknown>) => ({
					all: async () => {
						if (sql.includes('secret_entries')) return { results: [] }
						const [, sourceId, limit, offset] = args as [
							string,
							string,
							number,
							number,
						]
						return {
							results: (stored.rowsBySource[sourceId] ?? [])
								.slice(offset, offset + limit)
								.map((kv_key) => ({ kv_key, artifact_kind: 'module' })),
						}
					},
				}),
				all: async () => ({
					results: [
						{
							id: 'credential',
							owner_id: 'owner',
							allowed_packages: JSON.stringify(
								stored.packages.map((entry) => entry.id),
							),
						},
					],
				}),
			}),
		},
	} as unknown as Env
}

test('a package with more bundles than one call reads spans pages without losing or repeating a bundle', async () => {
	stored.packages = ['a', 'b', 'c'].map((id) => ({
		id,
		userId: 'owner',
		sourceId: `source-${id}`,
	}))
	stored.rowsBySource = {
		'source-a': ['a-1', 'a-2'],
		'source-b': ['b-1', 'b-2', 'b-3', 'b-4', 'b-5', 'b-6', 'b-7-read'],
		'source-c': ['c-1'],
	}
	const env = makeEnv()
	const seen: Record<string, { bundles: number; reads: number }> = {}
	const pages: Array<
		Awaited<ReturnType<typeof runListedPackageFetchBindingScan>>
	> = []
	let cursor: string | null = null
	do {
		const page = await runListedPackageFetchBindingScan({
			env,
			cursor,
			limit: 2,
			bundlesPerCall: 3,
		})
		pages.push(page)
		for (const entry of page.packages) {
			const total = (seen[entry.packageId] ??= { bundles: 0, reads: 0 })
			total.bundles += entry.bundles
			total.reads += entry.bundlesWithGlobalReads
		}
		cursor = page.nextCursor
	} while (cursor)
	expect(pages[0]?.lists).toEqual([
		{
			credentialId: 'credential',
			ownerId: 'owner',
			packageIds: ['a', 'b', 'c'],
		},
	])
	expect(pages.length).toBeGreaterThan(1)
	expect(pages.slice(1).every((page) => page.lists === null)).toBe(true)
	expect(seen).toEqual({
		a: { bundles: 2, reads: 0 },
		b: { bundles: 7, reads: 1 },
		c: { bundles: 1, reads: 0 },
	})
	const scanned = (packageId: string) =>
		pages.flatMap((page) =>
			page.packages
				.filter((entry) => entry.packageId === packageId)
				.map((entry) => ({
					bundles: entry.bundles,
					partial: entry.partial ?? false,
				})),
		)
	expect(scanned('b')).toEqual([
		{ bundles: 1, partial: true },
		{ bundles: 3, partial: true },
		{ bundles: 3, partial: true },
	])
	expect(scanned('a')).toEqual([{ bundles: 2, partial: false }])
	expect(scanned('c')).toEqual([{ bundles: 1, partial: false }])
	expect(pages.at(-1)?.nextCursor).toBeNull()
})

test('a package that fails ends the page so later packages are not read on the same call', async () => {
	stored.packages = ['a', 'b', 'c'].map((id) => ({
		id,
		userId: 'owner',
		sourceId: `source-${id}`,
	}))
	stored.rowsBySource = { 'source-b': ['b-1'], 'source-c': ['c-1'] }
	stored.failingSourceId = 'source-a'
	const env = makeEnv()
	const first = await runListedPackageFetchBindingScan({ env, limit: 3 })
	expect(first.packages.map((entry) => entry.outcome)).toEqual(['failed'])
	expect(first.nextCursor).toBe('a')
	const second = await runListedPackageFetchBindingScan({
		env,
		cursor: first.nextCursor,
		limit: 3,
	})
	expect(second.packages.map((entry) => entry.packageId)).toEqual(['b', 'c'])
	expect(second.nextCursor).toBeNull()
})
