import { expect, test } from 'vitest'
import {
	declaredWorkspacePaths,
	floorCiArgs,
	floorInstallArgs,
	formatFloorInstallFailure,
	lockfileWorkspacePaths,
	readNpmFloor,
} from './check-npm-install-floor.ts'

const supported = {
	packageManager: 'npm@11.11.1',
	devEngines: {
		packageManager: { name: 'npm', version: '>=11.11.1', onFail: 'error' },
	},
}

test('readNpmFloor returns the range floor and the pinned npm', () => {
	expect(readNpmFloor(supported)).toEqual({
		ok: true,
		npmFloor: { range: '>=11.11.1', floor: '11.11.1', pinned: '11.11.1' },
	})
})

test('readNpmFloor requires devEngines so an old npm fails fast', () => {
	const result = readNpmFloor({ packageManager: 'npm@11.11.1' })
	expect(result.ok).toBe(false)
	expect(result.ok ? [] : result.errors).toEqual([
		expect.stringContaining('devEngines.packageManager is missing'),
	])
})

test('readNpmFloor rejects a warn-only devEngines entry and a non-npm name', () => {
	const result = readNpmFloor({
		packageManager: 'npm@11.11.1',
		devEngines: {
			packageManager: { name: 'pnpm', version: '>=11.11.1', onFail: 'warn' },
		},
	})
	expect(result.ok ? [] : result.errors).toEqual([
		expect.stringContaining('name must be "npm"'),
		expect.stringContaining('onFail must be "error"'),
	])
})

test('readNpmFloor rejects a pinned npm outside the supported range', () => {
	const result = readNpmFloor({
		packageManager: 'npm@11.6.2',
		devEngines: supported.devEngines,
	})
	expect(result.ok ? [] : result.errors).toEqual([
		'packageManager npm@11.6.2 is outside devEngines.packageManager.version >=11.11.1. Move them together.',
	])
})

test('readNpmFloor rejects an invalid range and a loose packageManager pin', () => {
	const result = readNpmFloor({
		packageManager: 'npm@^11',
		devEngines: {
			packageManager: { name: 'npm', version: 'latest', onFail: 'error' },
		},
	})
	expect(result.ok ? [] : result.errors).toEqual([
		expect.stringContaining('must be a semver range'),
		expect.stringContaining('must pin an exact npm version'),
	])
})

test('the repo package.json declares a supported npm floor', async () => {
	const { readFile } = await import('node:fs/promises')
	const pkg = JSON.parse(await readFile('package.json', 'utf8'))
	const result = readNpmFloor(pkg)
	expect(result.ok ? [] : result.errors).toEqual([])
})

test('lockfileWorkspacePaths lists workspace manifests and skips node_modules', () => {
	expect(
		lockfileWorkspacePaths({
			packages: {
				'': {},
				'packages/worker': {},
				'packages/cli': {},
				'packages/cli/node_modules/msw': {},
				'node_modules/msw': {},
				'node_modules/kody-cli': {},
			},
		}),
	).toEqual(['packages/cli', 'packages/worker'])
})

test('declaredWorkspacePaths expands one-level globs so a workspace missing from the lockfile is still staged', () => {
	const directories: Record<string, Array<string>> = {
		'packages/mock-servers': ['github', 'brand-new'],
	}
	expect(
		declaredWorkspacePaths(
			{
				workspaces: [
					'packages/worker',
					'./packages/cli/',
					'packages/mock-servers/*',
					'packages/missing/*',
				],
			},
			(dir) => directories[dir] ?? [],
		),
	).toEqual([
		'packages/cli',
		'packages/mock-servers/brand-new',
		'packages/mock-servers/github',
		'packages/worker',
	])
	expect(declaredWorkspacePaths({}, () => [])).toEqual([])
})

test('floorInstallArgs runs the floor npm through npm exec', () => {
	expect(floorInstallArgs('11.11.1', floorCiArgs)).toEqual([
		'exec',
		'--yes',
		'--package=npm@11.11.1',
		'--',
		'npm',
		'ci',
		'--dry-run',
		'--ignore-scripts',
		'--no-audit',
		'--no-fund',
	])
})

test('formatFloorInstallFailure surfaces the Missing lines npm reports', () => {
	const message = formatFloorInstallFailure({
		floor: '10.9.3',
		range: '>=10.9.3',
		output: [
			'npm error code EUSAGE',
			'npm error',
			'npm error `npm ci` can only install packages when your package.json and package-lock.json are in sync.',
			'npm error',
			'npm error Missing: msw@2.15.0 from lock file',
			'npm error Missing: @mswjs/interceptors@0.41.9 from lock file',
		].join('\n'),
	})
	expect(message).toContain(
		'npm ci fails with npm 10.9.3, the lowest npm devEngines.packageManager.version (>=10.9.3) allows:',
	)
	expect(message).toContain('  Missing: msw@2.15.0 from lock file')
	expect(message).toContain(
		'  Missing: @mswjs/interceptors@0.41.9 from lock file',
	)
	expect(message).not.toContain('EUSAGE')
})
