import { expect, test } from 'vitest'
import {
	maxApiRequestBodyBytes,
	maxPackageCheckUploadBytes,
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

test('a package check upload can carry a tree as large as the publish checks accept (#5308)', () => {
	// Binaries travel as base64 (4 bytes per 3).
	expect(maxPackageCheckUploadBytes).toBeGreaterThan(
		Math.ceil((repoChecksSourceMaxTotalBytes * 4) / 3),
	)
})

test('origin refuses a JSON body over the general cap', async () => {
	expect(
		(await readJsonBody(jsonRequest(maxApiRequestBodyBytes + 1024))).kind,
	).toBe('too_large')
	expect((await readJsonBody(jsonRequest(1024))).kind).toBe('ok')
})
