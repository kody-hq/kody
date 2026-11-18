import { buildCredentialCreateHref } from '#universal/credential-contracts.ts'

/**
 * Why a credential cannot be read locally (ADR 0097), in the words the CLI,
 * the local-reads page, and the credential page all show, with the step that
 * fixes it when there is one.
 */
export type LocalReadsIneligibility = {
	cause: 'package_secret' | 'session_secret' | 'credential_kind' | 'connection'
	reason: string
	fix: { label: string; href: string } | null
}

export function packageSecretLocalReads(input: {
	orgSlug: string | null
	name: string
	packageId: string
	/** The package's kody id, or its id when the package is gone. */
	packageLabel: string
}): LocalReadsIneligibility {
	return {
		cause: 'package_secret',
		reason: `${input.name} is a package secret. It belongs to the package ${input.packageLabel}, and only that package's runs can use it, so it cannot be read locally. To read it on your machine, save the value again as an account secret locked to ${input.packageLabel}, then turn on local reads for that secret. To keep it as it is, use it from the package's code or an execute with {{secret:${input.name}}}.`,
		fix: {
			label: 'Save as an account secret',
			href: buildCredentialCreateHref({
				orgSlug: input.orgSlug,
				kind: 'secret',
				name: input.name,
				allowedPackages: [input.packageId],
			}),
		},
	}
}

export function sessionSecretLocalReads(name: string): LocalReadsIneligibility {
	return {
		cause: 'session_secret',
		reason: `${name} is a session secret. It lasts only for the execute session that saved it, so it cannot be read locally. Save it as an account secret to read it on your machine.`,
		fix: null,
	}
}

export function connectionLocalReads(name: string): LocalReadsIneligibility {
	return {
		cause: 'connection',
		reason: `${name} is a connection, not a secret. Kody keeps its token and places it on requests, so it cannot be read locally. Use it from an execute or a package with credential('${name}').`,
		fix: null,
	}
}

/** URL, login, and signing credentials live beside Keys but are not Keys. */
export function credentialKindLocalReads(
	name: string,
	kind: 'url' | 'login' | 'signing',
): LocalReadsIneligibility {
	const label = { url: 'secret URL', login: 'login', signing: 'signing key' }[
		kind
	]
	return {
		cause: 'credential_kind',
		reason: `${name} is a ${label}, and only Keys can be read locally. Use it from an execute or a package with credential('${name}'), or save the value as a Key and turn on local reads for that Key.`,
		fix: null,
	}
}
