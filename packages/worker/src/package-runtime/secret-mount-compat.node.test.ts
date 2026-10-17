import { expect, test } from 'vitest'
import { buildStaticPackageDependentsSummary } from './static-package-dependents.ts'
import {
	applySecretMountCompatToSummary,
	bundledPackageSecretMountReads,
	describeSecretMountCompat,
	readSecretMountAliases,
	secretMountsKeptCompatNote,
} from './secret-mount-compat.ts'

test('readSecretMountAliases lists mount aliases and ignores a missing key', () => {
	expect(
		readSecretMountAliases(
			JSON.stringify({
				kody: { secretMounts: { wakeToken: { name: 'wakeToken' } } },
			}),
		),
	).toEqual(['wakeToken'])
	expect(readSecretMountAliases(JSON.stringify({ kody: {} }))).toBeNull()
	expect(
		readSecretMountAliases(JSON.stringify({ kody: { secretMounts: {} } })),
	).toEqual([])
})

test('bundledPackageSecretMountReads names literal packageSecrets.get aliases', () => {
	expect(
		bundledPackageSecretMountReads({
			'src/wake.ts': [
				"import { packageSecrets } from 'kody:runtime'",
				'export default async function wake() {',
				'  return await packageSecrets.get("wakeToken")',
				'}',
			].join('\n'),
		}),
	).toEqual({ aliases: ['wakeToken'], computed: false })
	expect(
		bundledPackageSecretMountReads({
			'src/wake.ts': [
				"import { packageSecrets } from 'kody:runtime'",
				'export default async function wake(alias: string) {',
				'  return await packageSecrets.get(alias)',
				'}',
			].join('\n'),
		}),
	).toEqual({ aliases: [], computed: true })
})

test('publish that drops a mount alias names the stale static dependents', () => {
	const report = describeSecretMountCompat({
		keptAliases: [],
		dependents: [
			{
				packageId: 'pkg-dependent',
				name: '@kentcdodds/dependent',
				stale: true,
				aliases: ['wakeToken'],
				computed: false,
			},
		],
	})
	expect(report.notice).toContain('removes secret mount wakeToken')
	expect(report.notice).toContain('@kentcdodds/dependent')
	expect(report.notice).toContain(
		'Removing the mount or deleting the secret will break those dependents.',
	)
	const summary = applySecretMountCompatToSummary(
		buildStaticPackageDependentsSummary({
			total: 1,
			stale: 1,
			currentDependencyCommit: 'commit-v2',
			rows: [
				{
					packageId: 'pkg-dependent',
					packageKodyId: 'dependent',
					packageName: '@kentcdodds/dependent',
					sourceId: 'source-dependent',
					publishedCommit: 'commit-dependent',
					artifactKind: 'importable-module',
					artifactName: './main',
					entryPoint: 'src/main.ts',
					packageStale: true,
					matchingArtifactCount: 1,
					matchingEntrypointCount: 1,
					packageBundledDependencyCommit: 'commit-v1',
					bundledDependencyCommit: 'commit-v1',
				},
			],
		}),
		report,
	)
	expect(summary.recommended_next_action).toContain('@kentcdodds/dependent')
	expect(summary.recommended_next_action).toContain('wakeToken')
	expect(summary.items[0]?.recommended_action).toContain(
		'Removing secret mount wakeToken breaks @kentcdodds/dependent.',
	)
})

test('an unreadable stale snapshot is named when the publish removes a mount', () => {
	const report = describeSecretMountCompat({
		keptAliases: [],
		previousAliases: ['wakeToken'],
		dependents: [
			{
				packageId: 'pkg-dependent',
				name: '@kentcdodds/dependent',
				stale: true,
				aliases: [],
				computed: true,
			},
		],
	})
	expect(report.notice).toContain('removes secret mount wakeToken')
	expect(report.notice).toContain('@kentcdodds/dependent')
	expect(report.notice).toContain('could not be read')
	expect(report.notice).toContain(
		'Removing the mount or deleting the secret will break those dependents.',
	)
	expect(report.actionByPackageId.get('pkg-dependent')).toContain(
		'bundled snapshot could not be read',
	)
})

test('kept mounts name the stale dependents that still read them', () => {
	const report = describeSecretMountCompat({
		keptAliases: ['wakeToken'],
		dependents: [
			{
				packageId: 'pkg-dependent',
				name: '@kentcdodds/dependent',
				stale: true,
				aliases: ['wakeToken'],
				computed: false,
			},
		],
	})
	expect(report.notice).toContain(
		'kody.secretMounts kept only for stale static dependents: wakeToken.',
	)
	expect(report.notice).toContain('Still read by @kentcdodds/dependent.')
	expect(report.notice).toContain(
		'Removing a mount or deleting its secret breaks those dependents.',
	)
	expect(secretMountsKeptCompatNote(['wakeToken'])).toContain('wakeToken')
})
