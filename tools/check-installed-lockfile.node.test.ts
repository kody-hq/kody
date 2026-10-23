import { expect, test } from 'vitest'
import {
	findInstalledLockfileMismatches,
	inspectInstalledLockfile,
	isWorkspaceLockfilePath,
	resolveLockfileInstallPath,
} from './check-installed-lockfile.ts'

test('workspace lockfile paths match node_modules as a path segment', () => {
	expect(isWorkspaceLockfilePath('')).toBe(true)
	expect(isWorkspaceLockfilePath('packages/worker')).toBe(true)
	expect(isWorkspaceLockfilePath('packages/node_modules-utils')).toBe(true)
	expect(isWorkspaceLockfilePath('node_modules/remix')).toBe(false)
	expect(isWorkspaceLockfilePath('packages/worker/node_modules/satori')).toBe(
		false,
	)
})

test('installed lockfile check includes workspaces whose names contain node_modules text', () => {
	const lock = {
		packages: {
			'packages/node_modules-utils': {
				dependencies: { leftpad: '1.0.0' },
			},
			'packages/node_modules-utils/node_modules/leftpad': {
				version: '1.0.0',
			},
		},
	}

	expect(
		findInstalledLockfileMismatches({
			lock,
			readInstalledVersion: () => null,
		}),
	).toEqual([
		{
			name: 'leftpad',
			installPath: 'packages/node_modules-utils/node_modules/leftpad',
			lockedVersion: '1.0.0',
			installedVersion: null,
		},
	])
})

test('installed lockfile check flags stale or missing workspace and root dependencies', () => {
	const lock = {
		packages: {
			'': {
				devDependencies: { vitest: '^4.0.0' },
			},
			'packages/worker': {
				dependencies: { remix: '3.0.0' },
			},
			'node_modules/remix': { version: '3.0.0' },
			'node_modules/vitest': { version: '4.0.1' },
		},
	}

	expect(
		findInstalledLockfileMismatches({
			lock,
			readInstalledVersion: (installPath) =>
				installPath === 'node_modules/remix' ? '3.0.0-rc.4' : '4.0.1',
		}),
	).toEqual([
		{
			name: 'remix',
			installPath: 'node_modules/remix',
			lockedVersion: '3.0.0',
			installedVersion: '3.0.0-rc.4',
		},
	])

	const staleInspect = inspectInstalledLockfile({
		lock,
		readInstalledVersion: (installPath) =>
			installPath === 'node_modules/remix' ? '3.0.0-rc.4' : '4.0.1',
	})
	expect(staleInspect.ok).toBe(false)
	expect(staleInspect.detail).toContain('remix@3.0.0')
	expect(staleInspect.detail).toContain('3.0.0-rc.4')

	expect(
		inspectInstalledLockfile({
			lock,
			readInstalledVersion: (installPath) =>
				installPath === 'node_modules/remix' ? '3.0.0' : '4.0.1',
		}).ok,
	).toBe(true)

	expect(
		findInstalledLockfileMismatches({
			lock,
			readInstalledVersion: () => null,
		}),
	).toEqual([
		{
			name: 'remix',
			installPath: 'node_modules/remix',
			lockedVersion: '3.0.0',
			installedVersion: null,
		},
		{
			name: 'vitest',
			installPath: 'node_modules/vitest',
			lockedVersion: '4.0.1',
			installedVersion: null,
		},
	])
})

test('installed lockfile check compares nested workspace install paths', () => {
	const lock = {
		packages: {
			'packages/worker': {
				dependencies: { satori: '^0.32.0' },
			},
			'packages/worker/node_modules/satori': { version: '0.32.0' },
		},
	}

	expect(
		resolveLockfileInstallPath(lock.packages, 'packages/worker', 'satori'),
	).toBe('packages/worker/node_modules/satori')

	expect(
		findInstalledLockfileMismatches({
			lock,
			readInstalledVersion: () => null,
		}),
	).toEqual([
		{
			name: 'satori',
			installPath: 'packages/worker/node_modules/satori',
			lockedVersion: '0.32.0',
			installedVersion: null,
		},
	])

	expect(
		findInstalledLockfileMismatches({
			lock,
			readInstalledVersion: (installPath) =>
				installPath === 'packages/worker/node_modules/satori' ? '0.31.0' : null,
		}),
	).toEqual([
		{
			name: 'satori',
			installPath: 'packages/worker/node_modules/satori',
			lockedVersion: '0.32.0',
			installedVersion: '0.31.0',
		},
	])

	expect(
		inspectInstalledLockfile({
			lock,
			readInstalledVersion: (installPath) =>
				installPath === 'packages/worker/node_modules/satori' ? '0.32.0' : null,
		}).ok,
	).toBe(true)
})
