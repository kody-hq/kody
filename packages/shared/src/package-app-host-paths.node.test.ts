import { expect, test } from 'vitest'
import {
	isPackageAppHostNonLeafFirstSegment,
	isPackageAppHostReservedFirstSegment,
	isPackageAppHostSystemPath,
	isPackageAppLegacySubdomainMountPath,
	packageAppHostReservedFirstSegments,
	packageAppHostSystemPrefix,
} from './package-app-host-paths.ts'

test('system prefix and reserved first segments cover platform-owned paths', () => {
	expect(packageAppHostSystemPrefix).toBe('/-')
	for (const segment of [
		'-',
		'.well-known',
		'_kody',
		'robots.txt',
		'favicon.ico',
		'sitemap.xml',
	]) {
		expect(packageAppHostReservedFirstSegments.has(segment)).toBe(true)
		expect(isPackageAppHostReservedFirstSegment(segment)).toBe(true)
	}
	expect(isPackageAppHostReservedFirstSegment('.WELL-KNOWN')).toBe(true)
	expect(isPackageAppHostReservedFirstSegment('demo')).toBe(false)
	expect(isPackageAppHostReservedFirstSegment('packages')).toBe(false)
})

test('legacy mount detection requires a leaf after /packages/', () => {
	expect(isPackageAppLegacySubdomainMountPath('/packages/demo')).toBe(true)
	expect(isPackageAppLegacySubdomainMountPath('/packages/demo/x')).toBe(true)
	expect(isPackageAppLegacySubdomainMountPath('/packages')).toBe(false)
	expect(isPackageAppLegacySubdomainMountPath('/demo')).toBe(false)
	expect(isPackageAppLegacySubdomainMountPath('/packagesx/demo')).toBe(false)
})

test('non-leaf first segments include reserved names and the legacy mount', () => {
	expect(isPackageAppHostNonLeafFirstSegment('packages')).toBe(true)
	expect(isPackageAppHostNonLeafFirstSegment('-')).toBe(true)
	expect(isPackageAppHostNonLeafFirstSegment('@alice')).toBe(true)
	expect(isPackageAppHostNonLeafFirstSegment('demo')).toBe(false)
})

test('system path detection matches /- and descendants only', () => {
	expect(isPackageAppHostSystemPath('/-')).toBe(true)
	expect(isPackageAppHostSystemPath('/-/health')).toBe(true)
	expect(isPackageAppHostSystemPath('/-x')).toBe(false)
	expect(isPackageAppHostSystemPath('/demo/-/health')).toBe(false)
})
