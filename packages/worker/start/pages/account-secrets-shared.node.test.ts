import { expect, test } from 'vitest'
import { readAccountSecretsSaveWarning } from './account-secrets-shared.ts'

test('readAccountSecretsSaveWarning combines non-fatal save warnings', () => {
	expect(readAccountSecretsSaveWarning({})).toBeNull()
	expect(
		readAccountSecretsSaveWarning({
			providerLinkError: 'provider link failed',
		}),
	).toBe('provider link failed')
	expect(
		readAccountSecretsSaveWarning({
			renameCleanupError: 'old secret remains',
		}),
	).toBe('old secret remains')
	expect(
		readAccountSecretsSaveWarning({
			providerLinkError: 'provider link failed',
			renameCleanupError: 'old secret remains',
		}),
	).toBe('provider link failed old secret remains')
})
