import { expect, test } from 'vitest'
import {
	isPackageAppHostNonLeafFirstSegment,
	isPackageAppHostReservedFirstSegment,
	isPackageAppHostReservedPackageLeaf,
	isPackageAppHostRobotsTxtPath,
	isPackageAppHostSystemPath,
	isPackageAppHostWellKnownPath,
	isPackageAppLegacySubdomainMountPath,
	listPackageAppHostReservedPackageLeaves,
	packageAppHostDefaultRobotsTxt,
	packageAppHostReservedFirstSegments,
	packageAppHostReservedPackageLeafAuditSql,
	packageAppHostReservedPackageLeafMessage,
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

test('reserved package leaves include first segments and the legacy packages mount', () => {
	expect(isPackageAppHostReservedPackageLeaf('packages')).toBe(true)
	expect(isPackageAppHostReservedPackageLeaf('PACKAGES')).toBe(true)
	expect(isPackageAppHostReservedPackageLeaf('robots.txt')).toBe(true)
	expect(isPackageAppHostReservedPackageLeaf('demo')).toBe(false)
	expect(listPackageAppHostReservedPackageLeaves()).toEqual([
		'-',
		'.well-known',
		'_kody',
		'favicon.ico',
		'packages',
		'robots.txt',
		'sitemap.xml',
	])
	expect(packageAppHostReservedPackageLeafMessage('packages')).toContain(
		'reserved for package-app host paths',
	)
	expect(packageAppHostReservedPackageLeafMessage('packages')).not.toContain(
		'—',
	)
})

test('audit SQL lists reserved leaves and filters soft-deleted rows', () => {
	const sql = packageAppHostReservedPackageLeafAuditSql()
	expect(sql).toContain('deleted_at IS NULL')
	expect(sql).toContain("'packages'")
	expect(sql).toContain("'robots.txt'")
	expect(sql).toContain('lower(kody_id) IN')
})

test('root path helpers match robots.txt and .well-known only', () => {
	expect(isPackageAppHostRobotsTxtPath('/robots.txt')).toBe(true)
	expect(isPackageAppHostRobotsTxtPath('/robots.txt/')).toBe(false)
	expect(isPackageAppHostWellKnownPath('/.well-known')).toBe(true)
	expect(isPackageAppHostWellKnownPath('/.well-known/security.txt')).toBe(true)
	expect(isPackageAppHostWellKnownPath('/well-known')).toBe(false)
	expect(packageAppHostDefaultRobotsTxt).toBe('User-agent: *\nAllow: /\n')
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
