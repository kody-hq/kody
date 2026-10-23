import { expect, test } from 'vitest'
import {
	isPackageAppHostReservedFirstSegment,
	isPackageAppHostReservedPackageLeaf,
	isPackageAppHostNonLeafFirstSegment,
	isPackageAppHostRobotsTxtPath,
	isPackageAppHostSystemPath,
	isPackageAppHostWellKnownPath,
	isPackageAppLegacySubdomainMountPath,
} from './package-app-host-paths.ts'

test('reserved first segments and package leaves cover platform-owned paths', () => {
	for (const segment of [
		'-',
		'.well-known',
		'_kody',
		'robots.txt',
		'favicon.ico',
		'sitemap.xml',
	]) {
		expect(isPackageAppHostReservedFirstSegment(segment)).toBe(true)
	}
	expect(isPackageAppHostReservedFirstSegment('.WELL-KNOWN')).toBe(true)
	expect(isPackageAppHostReservedFirstSegment('demo')).toBe(false)
	expect(isPackageAppHostReservedFirstSegment('packages')).toBe(false)

	expect(isPackageAppHostReservedPackageLeaf('packages')).toBe(true)
	expect(isPackageAppHostReservedPackageLeaf('PACKAGES')).toBe(true)
	expect(isPackageAppHostReservedPackageLeaf('robots.txt')).toBe(true)
	expect(isPackageAppHostReservedPackageLeaf('demo')).toBe(false)
})

test('root path helpers match robots.txt and .well-known only', () => {
	expect(isPackageAppHostRobotsTxtPath('/robots.txt')).toBe(true)
	expect(isPackageAppHostRobotsTxtPath('/robots.txt/')).toBe(false)
	expect(isPackageAppHostWellKnownPath('/.well-known')).toBe(true)
	expect(isPackageAppHostWellKnownPath('/.well-known/security.txt')).toBe(true)
	expect(isPackageAppHostWellKnownPath('/well-known')).toBe(false)
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
