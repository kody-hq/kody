import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import {
	personalOrgId,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
	apiTokenLifetimeAliases,
	mintApiToken,
} from '#worker/api-tokens/service.ts'
import { planLimits } from '#universal/plans.ts'
import type * as PackageRegistryRepoModule from '#worker/package-registry/repo.ts'
import type * as PackageRegistrySourceModule from '#worker/package-registry/source.ts'
import type * as PublishedBundleArtifactsModule from '#worker/package-runtime/published-bundle-artifacts.ts'
import {
	createSavedPackageRecord,
	moduleGraphMockModule as mockModule,
} from '#worker/test-support/module-graph.ts'
import { createOpenApiTestHarness } from '#worker/test-support/open-api-http.ts'

vi.mock('#worker/package-registry/repo.ts', async (importOriginal) => ({
	...(await importOriginal<typeof PackageRegistryRepoModule>()),
	getSavedPackageByName: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByName(...args),
}))

vi.mock('#worker/package-registry/source.ts', async (importOriginal) => ({
	...(await importOriginal<typeof PackageRegistrySourceModule>()),
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageSourceBySourceId(...args),
	loadServingPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageSourceBySourceId(...args),
}))

vi.mock(
	'#worker/package-runtime/published-bundle-artifacts.ts',
	async (importOriginal) => ({
		...(await importOriginal<typeof PublishedBundleArtifactsModule>()),
		loadPublishedBundleArtifactByIdentity: (...args: Array<unknown>) =>
			mockModule.loadPublishedBundleArtifactByIdentity(...args),
	}),
)

// Saturday 22:34 UTC: the daily meter resets in 1h 26m.
const now = new Date('2026-10-10T22:34:00.000Z')

beforeEach(() => {
	vi.useFakeTimers({ now, toFake: ['Date'] })
})

afterEach(() => {
	vi.useRealTimers()
	vi.clearAllMocks()
})

const packageName = '@api-user/example-package'
const packageKodyId = 'example-package'
const greetSource =
	'export function greet(name) { return "hi " + name }\nexport default greet'

function stubPublishedGreetPackage(ownerUserId: string) {
	mockModule.getSavedPackageByName.mockResolvedValue({
		...createSavedPackageRecord({ name: packageName, kodyId: packageKodyId }),
		userId: personalOrgId(personIdFromStored(ownerUserId)),
	})
	const manifest = {
		name: packageName,
		exports: { './hello': './src/hello.ts' },
		kody: { id: packageKodyId, description: 'Example package' },
	}
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: { id: 'source-1', published_commit: 'commit-1' },
		manifest,
		files: {
			'package.json': JSON.stringify(manifest),
			'src/hello.ts': greetSource,
		},
	})
	mockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue({
		row: { id: 'artifact-hello' },
		artifact: {
			version: 1,
			kind: 'importable-module',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			artifactName: './hello',
			entryPoint: 'src/hello.ts',
			mainModule: 'dist/hello.js',
			modules: { 'dist/hello.js': greetSource },
			dependencies: [],
			packageContext: {
				packageId: 'pkg-1',
				kodyId: packageKodyId,
				sourceId: 'source-1',
			},
			createdAt: '2026-05-01T00:00:00.000Z',
		},
	})
}

async function createApiWithExhaustedOutboundMeter() {
	const api = await createOpenApiTestHarness()
	await api.userMeter.seed({
		userId: api.userId,
		resource: 'outbound_fetches_per_day',
		day: utcDayKey(now),
		count: planLimits.free.maxOutboundFetchesPerDay,
	})
	const { token } = await mintApiToken({
		db: api.db,
		userId: api.userId,
		name: 'local-execute',
		scopes: ['org:execute', 'package:execute'],
		idleTtlSeconds: apiTokenLifetimeAliases.short.idleTtlSeconds,
		maxLifetimeSeconds: apiTokenLifetimeAliases.short.maxLifetimeSeconds,
		createdVia: 'mcp-api',
	})
	return { api, token }
}

test('package-graph resolves saved package modules with the daily outbound meter exhausted', async () => {
	const { api, token } = await createApiWithExhaustedOutboundMeter()
	stubPublishedGreetPackage(api.userId)
	const specifier = `kody:${packageName}/hello`

	const response = await api.call('POST', '/v1/local-execute/package-graph', {
		token,
		body: {
			code: `import { greet } from '${specifier}'
export default async function main(params) { return greet(params.name) }`,
		},
	})

	expect(response.status).toBe(200)
	expect(response.body['imports']).toEqual([specifier])
	expect(response.body['modules']).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ name: specifier }),
			expect.objectContaining({
				name: expect.stringMatching(/\/\.__published_bundle__\/.*hello\.js$/),
			}),
		]),
	)
	expect(
		await api.userMeter.env.USER_METER.get(
			api.userMeter.env.USER_METER.idFromName(api.userId),
		).read({
			resource: 'outbound_fetches_per_day',
			day: utcDayKey(now),
			now: now.toISOString(),
		}),
	).toMatchObject({ count: planLimits.free.maxOutboundFetchesPerDay })
})

test('a CapabilityProxy gatewayFetch past the daily outbound cap says when the meter resets', async () => {
	const { api, token } = await createApiWithExhaustedOutboundMeter()
	const limit = planLimits.free.maxOutboundFetchesPerDay

	const response = await api.call('POST', '/v1/capability-proxy/call', {
		token,
		body: {
			path: ['kody', 'gatewayFetch'],
			args: [{ request: { url: 'https://api.github.com/rate_limit' } }],
		},
	})

	expect(response.status).toBe(429)
	expect(response.body.error?.message).toBe(
		`Plan limit reached: your "free" plan allows at most ${limit} outbound fetches per day and you currently have ${limit}. This daily limit resets at 00:00 UTC, in 1h 26m. Upgrade your plan at /@api-user/-/billing.`,
	)
})
