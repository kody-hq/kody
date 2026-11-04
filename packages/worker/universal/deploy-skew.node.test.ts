import { expect, test } from 'vitest'
import {
	deploySkewBuildHeader,
	deploySkewBuildMetaName,
	deploySkewReloadAttemptKey,
	isDeploySkewMismatch,
} from './deploy-skew.ts'

test('isDeploySkewMismatch requires both builds and detects inequality', () => {
	expect(isDeploySkewMismatch('aaa', 'bbb')).toBe(true)
	expect(isDeploySkewMismatch('aaa', 'aaa')).toBe(false)
	expect(isDeploySkewMismatch('  aaa  ', 'aaa')).toBe(false)
	expect(isDeploySkewMismatch(null, 'bbb')).toBe(false)
	expect(isDeploySkewMismatch('aaa', null)).toBe(false)
	expect(isDeploySkewMismatch('', 'bbb')).toBe(false)
	expect(isDeploySkewMismatch('aaa', '   ')).toBe(false)
	expect(isDeploySkewMismatch(undefined, undefined)).toBe(false)
})

test('deploy skew header and meta names stay stable for client/server wiring', () => {
	expect(deploySkewBuildHeader).toBe('X-Kody-Build')
	expect(deploySkewBuildMetaName).toBe('kody:build')
})

test('deploySkewReloadAttemptKey keys one attempt per server build and href', () => {
	expect(deploySkewReloadAttemptKey('abc', '/blog')).toBe('abc\n/blog')
	expect(deploySkewReloadAttemptKey(' abc ', '/blog')).toBe('abc\n/blog')
	expect(deploySkewReloadAttemptKey('abc', '/blog')).not.toBe(
		deploySkewReloadAttemptKey('def', '/blog'),
	)
	expect(deploySkewReloadAttemptKey('abc', '/blog')).not.toBe(
		deploySkewReloadAttemptKey('abc', '/docs'),
	)
})
