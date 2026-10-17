export type SecretProviderBindingRecord = {
	/** Stable credential id, assigned by the database on insert. */
	credentialId: string
	userId: string
	providerId: string
	packageId: string
	doorSecretName: string
	config: Record<string, string>
	/** Null means anywhere. Distinct from inject. */
	placement: {
		headers?: true | Array<string>
		query?: true
		path?: true
		body?: true
	} | null
	createdAt: string
	updatedAt: string
}

export type SecretProviderGrantRecord = {
	userId: string
	providerId: string
	canonicalRef: string
	packageId: string
	createdAt: string
}

export type SecretProviderConfig = Record<string, string>

export type SealedProviderCanonicalizeResult = {
	canonicalRef: string
}

export type SealedProviderResolveResult = {
	value: string
	hosts: Array<string>
	canonicalRef?: string
}

export type SecretProviderInvokeAction = 'canonicalize' | 'resolve'

export type SecretProviderInvokeInput = {
	action: SecretProviderInvokeAction
	providerId: string
	ref: string
	canonicalRef: string | null
	doorSecretName: string
	doorSecretValue: string
	config: SecretProviderConfig
}

export type ResolvedProviderSecret = {
	provider: string
	ref: string
	canonicalRef: string
	value: string
	hosts: Array<string>
}

export const secretProviderIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const maxSecretProviderRefLength = 512
export const maxSecretProviderConfigKeys = 16
export const maxSecretProviderConfigValueLength = 2_000
