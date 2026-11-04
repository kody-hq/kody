import { expect, test } from 'vitest'
import {
	deploySkewReloadAttemptKey,
	isDeploySkewMismatch,
	normalizeDeploySkewBuildId,
} from './deploy-skew.ts'

const left = 'a'.repeat(40)
const right = 'b'.repeat(40)

test('isDeploySkewMismatch requires both builds and detects inequality', () => {
	expect(isDeploySkewMismatch(left, right)).toBe(true)
	expect(isDeploySkewMismatch(left, left)).toBe(false)
	expect(isDeploySkewMismatch(`  ${left}  `, left)).toBe(false)
	expect(isDeploySkewMismatch(left.toUpperCase(), left)).toBe(false)
	expect(isDeploySkewMismatch(null, right)).toBe(false)
	expect(isDeploySkewMismatch(left, null)).toBe(false)
	expect(isDeploySkewMismatch('', right)).toBe(false)
	expect(isDeploySkewMismatch(left, '   ')).toBe(false)
	expect(isDeploySkewMismatch(undefined, undefined)).toBe(false)
})

test('normalizeDeploySkewBuildId lowercases and rejects short or junk IDs', () => {
	expect(normalizeDeploySkewBuildId('ABCDEF1')).toBeNull()
	expect(normalizeDeploySkewBuildId('a'.repeat(39))).toBeNull()
	expect(normalizeDeploySkewBuildId('a'.repeat(41))).toBeNull()
	expect(normalizeDeploySkewBuildId(`  ${'A'.repeat(40)}  `)).toBe(left)
	expect(normalizeDeploySkewBuildId(left.toUpperCase())).toBe(left)
	expect(normalizeDeploySkewBuildId('not-a-sha')).toBeNull()
	expect(normalizeDeploySkewBuildId('')).toBeNull()
})

test('deploySkewReloadAttemptKey keys one attempt per server build and href', () => {
	expect(deploySkewReloadAttemptKey(left, '/blog')).toBe(`${left}\n/blog`)
	expect(deploySkewReloadAttemptKey(` ${left.toUpperCase()} `, '/blog')).toBe(
		`${left}\n/blog`,
	)
	expect(deploySkewReloadAttemptKey(left, '/blog')).not.toBe(
		deploySkewReloadAttemptKey(right, '/blog'),
	)
	expect(deploySkewReloadAttemptKey(left, '/blog')).not.toBe(
		deploySkewReloadAttemptKey(left, '/docs'),
	)
})
