import { expect, test } from 'vitest'
import { readRetryablePackageInvocationInfrastructureCode } from './infrastructure-codes.ts'

test('platform-event retries cover artifact preparation failures', () => {
	expect(
		readRetryablePackageInvocationInfrastructureCode({
			status: 503,
			body: { error: { code: 'artifact_preparation_failed' } },
		}),
	).toBe('artifact_preparation_failed')
	expect(
		readRetryablePackageInvocationInfrastructureCode({
			status: 500,
			body: { error: { code: 'execution_failed' } },
		}),
	).toBeNull()
})
