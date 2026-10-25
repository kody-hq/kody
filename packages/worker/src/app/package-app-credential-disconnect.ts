export async function disconnectSelectedCredentials(input: {
	selectedCredentialIds: ReadonlyArray<string>
	mappedCredentialIds: ReadonlySet<string>
	isReferenced: (credentialId: string) => Promise<boolean>
	deleteCredential: (credentialId: string) => Promise<boolean>
}) {
	for (const credentialId of new Set(input.selectedCredentialIds)) {
		if (
			!input.mappedCredentialIds.has(credentialId) ||
			(await input.isReferenced(credentialId))
		) {
			continue
		}
		await input.deleteCredential(credentialId)
	}
}
