import { expect, test } from 'vitest'
import {
	activeWorkerVersion,
	settingsDigest,
} from './start-opt-in-cloudflare.ts'
import {
	overlapsRolloutHost,
	validateRouteSnapshot,
	validateRuntimeProof,
	validateRollbackRoute,
} from './start-opt-in-routing.ts'

const zone = 'a'.repeat(32)
const release = 'b'.repeat(40)
const domain = {
	id: 'c'.repeat(32),
	hostname: 'kody.codes',
	service: 'kody-production',
	zone_id: zone,
	environment: 'production',
}
const version = {
	deploymentId: 'd'.repeat(32),
	versionId: '11111111-1111-1111-1111-111111111111',
	settingsDigest: 'e'.repeat(64),
}
const proof = () => ({
	release,
	candidateName: `kody-start-${release}`,
	routerName: `kody-start-router-${release}`,
	checkedAt: '2026-10-15T18:00:00.000Z',
	versions: { candidate: version, router: version },
	health: 'passed',
	publicDocuments: 'passed',
	exactAssets: 'passed',
	anonymousDenial: 'passed',
	invalidPreference: 'legacy',
})
test.each([
	'kody.codes/*',
	'https://kody.codes/account/*',
	'*/*',
	'*kody.codes/*',
	'http://kody.codes/*',
])('detects route conflicts on the production host: %s', (pattern) =>
	expect(overlapsRolloutHost(pattern)).toBe(true),
)
test.each(['*.kody.codes/*', 'api.kody.codes/*', 'other.example/*'])(
	'keeps unrelated host routes separate: %s',
	(pattern) => expect(overlapsRolloutHost(pattern)).toBe(false),
)
test('activation requires existing legacy custom domain and rejects every overlapping zone route', () => {
	expect(
		validateRouteSnapshot(
			[{ id: 'x', pattern: 'api.kody.codes/*', script: 'other' }],
			[domain],
			zone,
		),
	).toEqual(domain)
	expect(() =>
		validateRouteSnapshot([], [{ ...domain, service: 'other-worker' }], zone),
	).toThrow('custom domain')
	expect(() => validateRouteSnapshot([], [domain, domain], zone)).toThrow(
		'custom domain',
	)
	expect(() =>
		validateRouteSnapshot(
			[{ id: 'x', pattern: 'kody.codes/account/*', script: 'other' }],
			[domain],
			zone,
		),
	).toThrow('Conflicting')
	expect(() =>
		validateRouteSnapshot(
			[
				{
					id: 'x',
					pattern: 'kody.codes/*',
					script: `kody-start-router-${release}`,
				},
			],
			[domain],
			zone,
		),
	).toThrow('Conflicting')
})
test('requires fresh successful exact release runtime proof', () => {
	const now = Date.parse('2026-10-15T18:30:00Z')
	expect(() => validateRuntimeProof(proof(), release, now)).not.toThrow()
	expect(() =>
		validateRuntimeProof({ ...proof(), release: 'f'.repeat(40) }, release, now),
	).toThrow('exact approved release')
	expect(() =>
		validateRuntimeProof(
			{ ...proof(), anonymousDenial: 'failed' },
			release,
			now,
		),
	).toThrow('checks must pass')
	expect(() => validateRuntimeProof(proof(), release, now + 3600000)).toThrow(
		'less than one hour',
	)
})
test('rollback validates only the exact captured overlay ID, name and pattern', () => {
	const route = {
		id: 'f'.repeat(32),
		pattern: 'kody.codes/*',
		script: `kody-start-router-${release}`,
	}
	const receipt = {
		accountId: '1'.repeat(32),
		zoneId: zone,
		release,
		route,
		beforeRoutes: [],
		beforeDomain: domain,
		versions: proof().versions,
		status: 'activated',
	}
	expect(() => validateRollbackRoute(route, receipt)).not.toThrow()
	expect(() =>
		validateRollbackRoute({ ...route, id: '2'.repeat(32) }, receipt),
	).toThrow('ownership changed')
	expect(() =>
		validateRollbackRoute({ ...route, script: 'kody-production' }, receipt),
	).toThrow('ownership changed')
	expect(() =>
		validateRollbackRoute(
			{ ...route, pattern: 'kody.codes/account/*' },
			receipt,
		),
	).toThrow('ownership changed')
})
test('worker evidence rejects split traffic and pins settings without depending on binding order', () => {
	expect(
		activeWorkerVersion({
			deployments: [
				{
					id: 'deployment',
					versions: [{ version_id: version.versionId, percentage: 100 }],
				},
			],
		}),
	).toEqual({ deploymentId: 'deployment', versionId: version.versionId })
	expect(() =>
		activeWorkerVersion({
			deployments: [
				{
					id: 'deployment',
					versions: [
						{ version_id: version.versionId, percentage: 50 },
						{ version_id: version.versionId, percentage: 50 },
					],
				},
			],
		}),
	).toThrow('single immutable')
	const settings = {
		bindings: [
			{ name: 'B', type: 'plain_text', text: 'b' },
			{ name: 'A', type: 'json', json: ['read', 'write'] },
		],
	}
	expect(settingsDigest(settings)).toBe(
		settingsDigest({ bindings: [...settings.bindings].reverse() }),
	)
	expect(settingsDigest(settings)).not.toBe(
		settingsDigest({
			bindings: [
				{ name: 'B', type: 'plain_text', text: 'b' },
				{ name: 'A', type: 'json', json: ['write', 'read'] },
			],
		}),
	)
})

test('unrecognized route schemes fail closed rather than hiding an overlap', () => {
	expect(() => overlapsRolloutHost('*://kody.codes/*')).toThrow(
		'Unrecognized zone route scheme',
	)
})
