import { expect, test, vi } from 'vitest'
import {
	disconnectCredentialAfterRevoke,
	disconnectSelectedCredentials,
} from './package-app-credential-disconnect.ts'

test('unchecked disconnect options do not delete credentials', async () => {
	const deleteCredential = vi.fn(async () => true)

	await disconnectSelectedCredentials({
		selectedCredentialIds: [],
		mappedCredentialIds: new Set(['credential-a']),
		isReferenced: async () => false,
		deleteCredential,
	})

	expect(deleteCredential).not.toHaveBeenCalled()
})

test('checked disconnect options delete only unreferenced mapped credentials', async () => {
	const deleteCredential = vi.fn(async () => true)

	await disconnectSelectedCredentials({
		selectedCredentialIds: [
			'credential-a',
			'credential-shared',
			'credential-not-mapped',
		],
		mappedCredentialIds: new Set(['credential-a', 'credential-shared']),
		isReferenced: async (credentialId) => credentialId === 'credential-shared',
		deleteCredential,
	})

	expect(deleteCredential).toHaveBeenCalledTimes(1)
	expect(deleteCredential).toHaveBeenCalledWith('credential-a')
})

test('disconnect failure after revoke is logged and does not reject', async () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

	try {
		await expect(
			disconnectCredentialAfterRevoke(async () => {
				throw new Error('credential store unavailable')
			}),
		).resolves.toBeUndefined()
		expect(warn).toHaveBeenCalledWith(
			'package-app-credential-disconnect-failed',
			'Error',
		)
	} finally {
		warn.mockRestore()
	}
})
