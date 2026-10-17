import { isRedirect } from '@tanstack/react-router'
import { savePackageCredentialMappings } from '#start/server/credential-approval-mutation'
import {
	type CredentialMappingChange,
	type PackageCredentialsEnablementAction,
} from '#universal/credential-contracts.ts'
import { type PackageCredentialsWriteResult } from '#client/routes/package-credentials-editing.ts'
export async function postPackageCredentialChanges(input: {
	username: string
	kodyId: string
	changes?: Array<CredentialMappingChange>
	enablements?: Array<PackageCredentialsEnablementAction>
}): Promise<PackageCredentialsWriteResult> {
	try {
		const payload = await savePackageCredentialMappings({ data: input })
		if (payload.ok) return { kind: 'saved', view: payload }
		if ('errors' in payload && payload.errors.length)
			return { kind: 'refused', errors: payload.errors }
		return {
			kind: 'error',
			message:
				'error' in payload
					? payload.error
					: 'Unable to save credential mapping.',
		}
	} catch (error) {
		if (isRedirect(error)) throw error
		return error instanceof Error && error.message === 'Please sign in again.'
			? { kind: 'unauthorized' }
			: {
					kind: 'error',
					message:
						error instanceof Error
							? error.message
							: 'Unable to save credential mapping.',
				}
	}
}
