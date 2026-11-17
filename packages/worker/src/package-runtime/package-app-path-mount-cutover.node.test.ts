import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import {
	buildPackageAppPathMountCutoverLocation,
	isPackageAppPathMountCutOver,
	packageAppPathMountCutoverAt,
} from './package-app-path-mount-cutover.ts'

const cutoverAt = Date.parse(packageAppPathMountCutoverAt)
const env = { PACKAGE_APP_PATH_MOUNT_CUTOVER_AT: packageAppPathMountCutoverAt }

function locationAt(now: number, overrides: { kodyId?: string } = {}) {
	return buildPackageAppPathMountCutoverLocation({
		env,
		packageAppOrigin: 'https://kody.run',
		packagePath: {
			username: 'kent',
			kodyId: overrides.kodyId ?? 'memo',
			restPath: '/notes/1',
		},
		url: new URL('https://kent.kody.run/memo/notes/1?tab=2'),
		now,
	})
}

test('the path address serves until the cutover moment and redirects from it on', () => {
	expect(isPackageAppPathMountCutOver({ env, now: cutoverAt - 1 })).toBe(false)
	expect(locationAt(cutoverAt - 1)).toBeNull()

	expect(isPackageAppPathMountCutOver({ env, now: cutoverAt })).toBe(true)
	expect(locationAt(cutoverAt)).toBe(
		'https://memo--kent.kody.run/notes/1?tab=2',
	)
})

test('an unset or unparsable cutover never redirects', () => {
	const later = cutoverAt + 365 * 24 * 60 * 60 * 1000
	expect(isPackageAppPathMountCutOver({ env: {}, now: later })).toBe(false)
	expect(
		isPackageAppPathMountCutOver({
			env: { PACKAGE_APP_PATH_MOUNT_CUTOVER_AT: 'December 17' },
			now: later,
		}),
	).toBe(false)
})

test('an app with no valid host label keeps its path address after cutover', () => {
	expect(locationAt(cutoverAt, { kodyId: 'Not_Kebab' })).toBeNull()
})

test('both workers that serve package apps are configured with the cutover the owner notice promised', () => {
	for (const config of [
		'../../wrangler.jsonc',
		'../../../runtime-worker/wrangler.jsonc',
	]) {
		const wrangler = readFileSync(new URL(config, import.meta.url), 'utf8')
		const configured = [
			...wrangler.matchAll(/"PACKAGE_APP_PATH_MOUNT_CUTOVER_AT":\s*"([^"]+)"/g),
		].map((match) => match[1])
		expect(configured).toEqual([packageAppPathMountCutoverAt])
	}
	expect(new Date(cutoverAt).toISOString()).toBe('2026-12-17T20:45:00.000Z')
})
