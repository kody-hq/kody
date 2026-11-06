import {
	callPurposeCommands,
	describeCliCredential,
	noteActiveLoginCredential,
	replaceStoredTokenCommand,
	resolveCliCredential,
	sessionPurposeCommands,
	type CliCredential,
	type CliCredentialCandidate,
} from './cli-credential.js'

type WhoamiCredentialJson = {
	source: CliCredentialCandidate['source']
	label: string
	tokenId?: string
	org?: string
}

function credentialJson(
	candidate: CliCredentialCandidate,
	tokenId?: string,
): WhoamiCredentialJson {
	const id = tokenId ?? candidate.stored?.tokenId
	return {
		source: candidate.source,
		label: describeCliCredential(candidate),
		...(id ? { tokenId: id } : {}),
		...(candidate.login?.org ? { org: candidate.login.org } : {}),
	}
}

/**
 * Lines about credentials that exist but are not the one in use. When a
 * stored API token outranks a login, say so plainly: `kody login` does not
 * replace it.
 */
function formatShadowedCredentials(input: {
	credential: CliCredential
	/** Who `search` / cloud execute use, when it differs. */
	session: CliCredentialCandidate | null
}): Array<string> {
	const { credential, session } = input
	const lines: Array<string> = []
	for (const other of credential.shadowed) {
		lines.push(
			`also stored: ${describeCliCredential(other)} (not used: ${describeCliCredential(credential)} takes precedence)`,
		)
	}
	if (session && session.source !== credential.source) {
		lines.push(
			`note: ${sessionPurposeCommands} use the ${describeCliCredential(session)} first; ${callPurposeCommands} use the ${describeCliCredential(credential)}.`,
		)
	}
	if (
		credential.source === 'stored-api-token' &&
		credential.shadowed.some((other) => other.source === 'login')
	) {
		lines.push(
			`\`kody login\` does not replace a stored API token. To change its scopes, run \`${replaceStoredTokenCommand(credential.stored?.scopes)}\` (mints with your login session and replaces the stored token).`,
		)
	}
	return lines
}

/** `kody whoami`: the credential commands will use, its scopes, and any other stored one. */
export async function runWhoami(input: {
	tokenValues: { token?: string }
	mcpUrl: string
	apiUrl: string
	org?: string
	json: boolean
	write: (text: string) => void
}): Promise<number> {
	const { tokenValues, mcpUrl, apiUrl, org, json, write } = input
	const resolveInput = {
		tokenValues,
		mcpUrl,
		apiUrl,
		...(org ? { org } : {}),
	}
	const session = resolveCliCredential({ ...resolveInput, purpose: 'session' })
	// Resolve `call` last so error messages name the credential whoami used.
	let credential = resolveCliCredential(resolveInput)
	const { whoamiWithApiToken } = await import('./open-api-client.js')
	let token: string
	let loginOrg: string | null = null
	if (credential?.token) {
		token = credential.token
	} else {
		const { ensureOpenApiCredentials } = await import('./auth.js')
		const login = await ensureOpenApiCredentials({ mcpUrl, org, apiUrl })
		noteActiveLoginCredential({ login })
		credential = credential
			? { ...credential, login }
			: { source: 'login', token: null, login, purpose: 'call', shadowed: [] }
		token = login.accessToken
		loginOrg = login.org ?? null
	}
	const identity = await whoamiWithApiToken({
		token,
		apiUrl,
		...(org ? { org } : {}),
	})
	const shadowedLines = formatShadowedCredentials({ credential, session })
	const loginStoredOrg =
		credential.source === 'login' ? (credential.login?.org ?? null) : null
	const actingOrgSlug =
		org ?? loginOrg ?? loginStoredOrg ?? identity.org?.slug ?? null
	const actingOrgKind =
		identity.org && identity.org.slug === actingOrgSlug
			? identity.org.kind
			: null
	const workspaceNote = actingOrgSlug
		? `workspace: acts in @${actingOrgSlug}${actingOrgKind ? ` (${actingOrgKind})` : ''}. Local execute is a compute venue, not a personal-workspace switch. Credentials cannot be moved between orgs — reconnect under the right workspace.`
		: 'workspace: pass --org or set KODY_ORG (user-owned tokens default to your personal workspace when omitted). Local execute is a compute venue, not a personal-workspace switch. Credentials cannot be moved between orgs — reconnect under the right workspace.'
	if (json) {
		write(
			`${JSON.stringify(
				{
					apiUrl: identity.apiUrl,
					credential: credentialJson(credential, identity.token.id),
					otherCredentials: credential.shadowed.map((other) =>
						credentialJson(other),
					),
					...(session && session.source !== credential.source
						? { searchAndCloudExecuteCredential: credentialJson(session) }
						: {}),
					...(actingOrgSlug
						? {
								org: actingOrgSlug,
								...(actingOrgKind || identity.org
									? {
											workspace: {
												slug: actingOrgSlug,
												...(actingOrgKind
													? {
															kind: actingOrgKind,
															personal: actingOrgKind === 'personal',
														}
													: identity.org),
											},
										}
									: {}),
							}
						: {}),
					...(credential.source === 'login'
						? { scope: identity.token.scopes }
						: {}),
					token: identity.token,
					user: identity.user,
					notes: [...shadowedLines, workspaceNote],
				},
				null,
				2,
			)}\n`,
		)
		return 0
	}
	const userLine = identity.user
		? `${identity.user.displayName} <${identity.user.email}>`
		: credential.source === 'login'
			? '(no profile)'
			: '(account:read not on this token)'
	write(
		[
			`api: ${identity.apiUrl}`,
			`credential: ${describeCliCredential(credential)}${credential.source === 'login' ? '' : ` [${identity.token.id}]`}`,
			...(actingOrgSlug
				? [
						`org: ${actingOrgSlug}${actingOrgKind ? ` (${actingOrgKind} workspace)` : ''}`,
					]
				: []),
			`user: ${userLine}`,
			`scopes: ${identity.token.scopes.join(', ') || '(none)'}`,
			`expires: ${identity.token.expiresAt ?? 'unknown'}`,
			...shadowedLines,
			workspaceNote,
			'',
		].join('\n'),
	)
	return 0
}
