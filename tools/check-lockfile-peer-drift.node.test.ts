import { expect, test } from 'vitest'
import {
	checkLockfilePeerDrift,
	findLockfilePeerDrift,
	findWorkspaceDuplicates,
} from './check-lockfile-peer-drift.ts'

test('lockfile peer drift flags a direct dependency npm install would bump', async () => {
	const drifted = {
		packages: {
			'': {
				devDependencies: {
					'@cloudflare/workers-types': '^5.20260904.1',
					vite: '^8.2.2',
				},
			},
			'packages/status': {
				devDependencies: {
					'@cloudflare/workers-types': '^5.20260904.1',
				},
			},
			'node_modules/@cloudflare/workers-types': {
				version: '5.20260904.1',
			},
			'node_modules/wrangler': {
				peerDependencies: {
					'@cloudflare/workers-types': '^5.20260911.1',
				},
				peerDependenciesMeta: {
					'@cloudflare/workers-types': { optional: true },
				},
			},
			'node_modules/vite': { version: '8.2.2' },
			'node_modules/some-tool/node_modules/plugin': {
				peerDependencies: { vite: '^7.0.0' },
			},
		},
	}

	expect(findLockfilePeerDrift(drifted)).toEqual([
		{
			name: '@cloudflare/workers-types',
			lockedVersion: '5.20260904.1',
			directRanges: ['^5.20260904.1'],
			peerRange: '^5.20260911.1',
			from: 'node_modules/wrangler',
		},
	])

	const satisfied = {
		packages: {
			'': {
				devDependencies: {
					'@cloudflare/workers-types': '^5.20260904.1',
				},
			},
			'node_modules/@cloudflare/workers-types': {
				version: '5.20260923.1',
			},
			'node_modules/wrangler': {
				peerDependencies: {
					'@cloudflare/workers-types': '^5.20260911.1',
				},
				peerDependenciesMeta: {
					'@cloudflare/workers-types': { optional: true },
				},
			},
		},
	}
	expect(findLockfilePeerDrift(satisfied)).toEqual([])

	const blockedByExactPin = {
		packages: {
			'': {
				devDependencies: {
					'@cloudflare/workers-types': '5.20260904.1',
				},
			},
			'node_modules/@cloudflare/workers-types': {
				version: '5.20260904.1',
			},
			'node_modules/wrangler': {
				peerDependencies: {
					'@cloudflare/workers-types': '^5.20260911.1',
				},
			},
		},
	}
	expect(findLockfilePeerDrift(blockedByExactPin)).toEqual([])

	expect(await checkLockfilePeerDrift()).toEqual([])
})

test('lockfile check flags a package each workspace nests with no root copy', () => {
	const duplicated = {
		packages: {
			'': {},
			'packages/cli': { dependencies: { xstate: '6.0.0-beta.1' } },
			'packages/worker': { dependencies: { xstate: '6.0.0-beta.1' } },
			'packages/cli/node_modules/xstate': { version: '6.0.0-beta.1' },
			'packages/worker/node_modules/xstate': { version: '6.0.0-beta.1' },
			'packages/worker/node_modules/semver': { version: '7.0.0' },
			'node_modules/some-tool/node_modules/semver': { version: '7.0.0' },
		},
	}
	expect(findWorkspaceDuplicates(duplicated)).toEqual([
		{
			name: 'xstate',
			version: '6.0.0-beta.1',
			installPaths: [
				'packages/cli/node_modules/xstate',
				'packages/worker/node_modules/xstate',
			],
		},
	])

	const hoisted = {
		packages: {
			'': {},
			'node_modules/xstate': { version: '6.0.0-beta.3' },
			'packages/cli/node_modules/xstate': { version: '6.0.0-beta.1' },
			'packages/worker/node_modules/xstate': { version: '6.0.0-beta.1' },
		},
	}
	expect(findWorkspaceDuplicates(hoisted)).toEqual([])
})
