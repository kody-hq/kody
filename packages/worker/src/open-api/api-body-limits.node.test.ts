import { expect, test } from 'vitest'
import {
	maxApiRequestBodyBytes,
	maxPackageCheckRequestBodyBytes,
	maxRequestBodyBytesForOperation,
} from './api-body-limits.ts'
import { readJsonBody } from './request-params.ts'
import { repoChecksSourceMaxTotalBytes } from '#worker/repo/checks.ts'

function jsonRequest(bytes: number) {
	const padding = 'x'.repeat(bytes - '{"files":{"a":""}}'.length)
	return new Request('https://api.kody.test/v1/packages/check', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: `{"files":{"a":"${padding}"}}`,
	})
}

test('packageCheck accepts a tree as large as the publish checks accept (#5308)', async () => {
	expect(maxRequestBodyBytesForOperation('memoryCreate')).toBe(
		maxApiRequestBodyBytes,
	)
	const cap = maxRequestBodyBytesForOperation('packageCheck')
	expect(cap).toBe(maxPackageCheckRequestBodyBytes)
	// Binaries travel as base64 (4 bytes per 3).
	expect(cap).toBeGreaterThan(
		Math.ceil((repoChecksSourceMaxTotalBytes * 4) / 3),
	)

	const overGeneralCap = maxApiRequestBodyBytes + 1024
	expect((await readJsonBody(jsonRequest(overGeneralCap))).kind).toBe(
		'too_large',
	)
	expect((await readJsonBody(jsonRequest(overGeneralCap), cap)).kind).toBe('ok')
	expect((await readJsonBody(jsonRequest(cap + 1), cap)).kind).toBe('too_large')
})
