import {
	getAuthSessionExpiresAtMs,
	readParsedAuthSession,
} from '#app/auth-session.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	packageAppOauthAppDomain,
	packageAppOauthClaimLabels,
} from '#app/package-app-oauth-consent-copy.ts'
import { mintPackageAppOauthCode } from '#app/package-app-oauth-codes.ts'
import { parsePackageAppOauthClientId } from '#app/package-app-oauth-client-id.ts'
import { resolvePackageAppOauthClient } from '#app/package-app-oauth-client-resolve.ts'
import {
	findLivePackageAppOauthGrant,
	grantCoversScopes,
	upsertPackageAppOauthGrant,
	upsertPackageAppOauthGrantWithCredentialMappings,
} from '#app/package-app-oauth-grants.ts'
import { isAllowedPackageAppOauthRedirectUri } from '#app/package-app-oauth-redirect-uris.ts'
import {
	parsePackageAppOauthScopes,
	visitorNeedKeysOfScopes,
	type PackageAppOauthScope,
} from '#app/package-app-oauth-scopes.ts'
import { resolvePackageAppOrgOwnerByHandle } from '#app/package-app-owner.ts'
import { viewerCanExecutePackageApp } from '#app/package-viewer-access.ts'
import { redirectToLoginWhenUnauthenticated } from '#app/auth-redirect.ts'
import { resolvePackageListIconUrl } from '#universal/identity-icon-urls.ts'
import { type PackageAppOauthConsentLoaderData } from '#universal/loader-data.ts'
import { packageAppOauthPaths } from '#universal/package-app-oauth-paths.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { resolveDisplayName } from '#worker/identity/username.ts'
import {
	loadInvokeManifestBySourceId,
	resolveSavedPackageForPackageAppSlug,
} from '#worker/package-invocations/module-artifacts.ts'
import { getPackageNameLeaf } from '#worker/package-registry/package-name.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { getPkceValidationError } from '#worker/oauth-pkce.ts'
import {
	liveUsableCredentials,
	listUsableCredentials,
	resolveNeedCandidates,
} from '#worker/credentials/credential-candidates.ts'
import { loadPublishedCredentialNeeds } from '#worker/credentials/credential-needs-closure.ts'
import { buildNeedCreateUrl } from '#worker/credentials/need-create-url.ts'
import { type CredentialNeed } from '#worker/credentials/credential-needs.ts'

/**
 * App-origin authorize + consent for hosted package apps.
 *
 * Consent is skipped when the visitor owns the package org, already has
 * `app:execute` on that app, or holds a live grant covering the requested
 * scopes. Email always requires an explicit grant (or a prior email grant).
 */

function redirectWithError(input: {
	redirectUri: string | null
	state: string | null
	error: string
	description: string
}) {
	if (!input.redirectUri) {
		return new Response(`${input.error}: ${input.description}`, {
			status: 400,
			headers: {
				'Cache-Control': 'no-store',
				'Content-Type': 'text/plain; charset=utf-8',
			},
		})
	}
	const target = new URL(input.redirectUri)
	target.searchParams.set('error', input.error)
	target.searchParams.set('error_description', input.description)
	if (input.state) target.searchParams.set('state', input.state)
	return new Response(null, {
		status: 302,
		headers: {
			Location: target.toString(),
			'Cache-Control': 'no-store',
			'Referrer-Policy': 'no-referrer',
		},
	})
}

type AuthorizeQuery = {
	clientIdRaw: string | null
	redirectUri: string | null
	state: string | null
	codeChallenge: string | null
	codeChallengeMethod: string | null
	scopeRaw: string | null
	responseType: string | null
	selectedScopesRaw?: string
	credentialSelections?: Record<string, string>
}

function readAuthorizeQuery(url: URL): AuthorizeQuery {
	return {
		clientIdRaw: url.searchParams.get('client_id'),
		redirectUri: url.searchParams.get('redirect_uri'),
		state: url.searchParams.get('state'),
		codeChallenge: url.searchParams.get('code_challenge'),
		codeChallengeMethod: url.searchParams.get('code_challenge_method'),
		scopeRaw: url.searchParams.get('scope'),
		responseType: url.searchParams.get('response_type'),
	}
}

async function shouldSkipConsent(input: {
	env: Env
	personId: string
	orgUsername: string
	kodyId: string
	ownerId: string
	appId: string
	viewer: Parameters<typeof viewerCanExecutePackageApp>[0]['viewer']
	scopes: ReadonlyArray<PackageAppOauthScope>
}): Promise<boolean> {
	const grant = await findLivePackageAppOauthGrant({
		db: input.env.APP_DB,
		personId: input.personId,
		orgUsername: input.orgUsername,
		kodyId: input.kodyId,
	})
	if (grant && grantCoversScopes(grant, input.scopes)) return true
	if (
		input.scopes.includes('email') ||
		visitorNeedKeysOfScopes(input.scopes).length > 0
	) {
		return false
	}
	return await viewerCanExecutePackageApp({
		env: input.env,
		viewer: input.viewer,
		ownerId: input.ownerId,
		appId: input.appId,
	})
}

async function issueCodeAndRedirect(input: {
	env: Env
	request: Request
	personId: string
	username: string
	orgUsername: string
	kodyId: string
	redirectUri: string
	codeChallenge: string
	scopes: Array<PackageAppOauthScope>
	state: string | null
	recordGrant: boolean
}) {
	const parsedSession = await readParsedAuthSession(input.request)
	if (!parsedSession) {
		return await redirectToLoginWhenUnauthenticated(input.request, input.env)
	}
	if (input.recordGrant) {
		await upsertPackageAppOauthGrant({
			db: input.env.APP_DB,
			personId: input.personId,
			orgUsername: input.orgUsername,
			kodyId: input.kodyId,
			scopes: input.scopes,
		})
	}
	const minted = await mintPackageAppOauthCode({
		env: input.env,
		record: {
			personId: input.personId,
			username: input.username,
			orgUsername: input.orgUsername,
			kodyId: input.kodyId,
			redirectUri: input.redirectUri,
			codeChallenge: input.codeChallenge,
			scopes: input.scopes,
			sessionExpiresAt: getAuthSessionExpiresAtMs({
				rememberMe: parsedSession.session.rememberMe,
				issuedAt: parsedSession.issuedAt,
			}),
		},
	})
	if (!minted) {
		return new Response('Authorization code storage is unavailable.', {
			status: 503,
			headers: { 'Cache-Control': 'no-store' },
		})
	}
	const target = new URL(input.redirectUri)
	target.searchParams.set('code', minted.code)
	if (input.state) target.searchParams.set('state', input.state)
	return new Response(null, {
		status: 302,
		headers: {
			Location: target.toString(),
			'Cache-Control': 'no-store',
			'Referrer-Policy': 'no-referrer',
		},
	})
}

async function loadConsentPackageMeta(input: {
	env: Env
	orgUsername: string
	kodyId: string
}) {
	let packageName = input.kodyId
	let publisherDisplayName = input.orgUsername
	let iconUrl: string | null = null
	try {
		const org = await resolvePackageAppOrgOwnerByHandle({
			env: input.env,
			handle: input.orgUsername,
		})
		if (org) {
			publisherDisplayName = org.displayName || input.orgUsername
			const lookup = await resolveSavedPackageForPackageAppSlug({
				db: input.env.APP_DB,
				userId: org.userId,
				slug: input.kodyId,
			})
			if (lookup) {
				packageName = getPackageNameLeaf(lookup.savedPackage.name)
				const source = await getEntitySourceById(
					input.env.APP_DB,
					lookup.savedPackage.sourceId,
				)
				iconUrl = resolvePackageListIconUrl({
					username: input.orgUsername,
					kodyId: input.kodyId,
					listingId: null,
					listingIconCommit: null,
					publishedCommit: source?.published_commit ?? null,
				})
			}
		}
	} catch {
		// Consent still renders when package metadata tables are unavailable.
	}
	return { packageName, publisherDisplayName, iconUrl }
}

async function parseAndValidateAuthorizeRequest(input: {
	env: Env
	query: AuthorizeQuery
	requestUrl: string | URL
	request: Request
}) {
	const parsed = parsePackageAppOauthClientId(input.query.clientIdRaw)
	if (!parsed) {
		return {
			ok: false as const,
			response: redirectWithError({
				redirectUri: null,
				state: input.query.state,
				error: 'invalid_client',
				description: 'client_id must be owner/leaf for a hosted package app.',
			}),
		}
	}
	const resolved = await resolvePackageAppOauthClient({
		env: input.env,
		username: parsed.username,
		kodyId: parsed.kodyId,
	})
	if (!resolved) {
		return {
			ok: false as const,
			response: redirectWithError({
				redirectUri: null,
				state: input.query.state,
				error: 'invalid_client',
				description:
					'client_id must name a published package app (owner/leaf exists and is served).',
			}),
		}
	}
	const client = resolved.client
	// Allowlist redirect_uri before any error redirect that would use it —
	// otherwise unsupported_response_type becomes an open redirect.
	if (!input.query.redirectUri) {
		return {
			ok: false as const,
			response: redirectWithError({
				redirectUri: null,
				state: input.query.state,
				error: 'invalid_request',
				description: 'redirect_uri is required.',
			}),
		}
	}
	const allowed = await isAllowedPackageAppOauthRedirectUri({
		env: input.env,
		client,
		redirectUri: input.query.redirectUri,
		requestUrl: input.requestUrl,
	})
	if (!allowed) {
		return {
			ok: false as const,
			response: redirectWithError({
				redirectUri: null,
				state: input.query.state,
				error: 'invalid_request',
				description:
					'redirect_uri must be the /-/auth/callback on a verified origin for this package.',
			}),
		}
	}
	const safeRedirectUri = input.query.redirectUri
	if (input.query.responseType !== 'code') {
		return {
			ok: false as const,
			response: redirectWithError({
				redirectUri: safeRedirectUri,
				state: input.query.state,
				error: 'unsupported_response_type',
				description: 'response_type must be code.',
			}),
		}
	}
	const pkceError = getPkceValidationError({
		codeChallenge: input.query.codeChallenge ?? undefined,
		codeChallengeMethod: input.query.codeChallengeMethod ?? undefined,
	})
	if (pkceError || !input.query.codeChallenge) {
		return {
			ok: false as const,
			response: redirectWithError({
				redirectUri: safeRedirectUri,
				state: input.query.state,
				error: 'invalid_request',
				description: pkceError ?? 'PKCE code_challenge is required.',
			}),
		}
	}
	const { scopes, error: scopeError } = parsePackageAppOauthScopes(
		input.query.scopeRaw,
	)
	if (scopeError) {
		return {
			ok: false as const,
			response: redirectWithError({
				redirectUri: safeRedirectUri,
				state: input.query.state,
				error: 'invalid_scope',
				description: scopeError,
			}),
		}
	}
	const needKeys = visitorNeedKeysOfScopes(scopes)
	const visitorNeedDescriptions: Record<string, string> = {}
	let credentialNeeds: Array<CredentialNeed> = []
	if (needKeys.length > 0) {
		const { manifest } = await loadInvokeManifestBySourceId({
			env: input.env,
			userId: resolved.org.userId,
			sourceId: resolved.savedPackage.sourceId,
		})
		credentialNeeds = await loadPublishedCredentialNeeds({
			env: input.env,
			userId: resolved.org.userId,
			sourceId: resolved.savedPackage.sourceId,
			request: input.request,
		})
		const declared = manifest.kody.app?.visitorNeeds ?? {}
		for (const key of needKeys) {
			const executorNeed = credentialNeeds.find(
				(need) => need.key === key && need.supplier === 'executor',
			)
			const visitorNeed = Object.hasOwn(declared, key)
				? declared[key]
				: undefined
			const visitorCredentialNeed = visitorNeed?.credential
				? credentialNeeds.find((need) => need.key === visitorNeed.credential)
				: undefined
			if (visitorCredentialNeed?.supplier === 'publisher') {
				return {
					ok: false as const,
					response: redirectWithError({
						redirectUri: safeRedirectUri,
						state: input.query.state,
						error: 'invalid_scope',
						description: `kody.app.visitorNeeds.${key} cannot reference publisher-supplied credential need "${visitorCredentialNeed.key}".`,
					}),
				}
			}
			if (!executorNeed && !visitorNeed) {
				return {
					ok: false as const,
					response: redirectWithError({
						redirectUri: safeRedirectUri,
						state: input.query.state,
						error: 'invalid_scope',
						description: `need:${key} is not declared in this app's kody.app.visitorNeeds.`,
					}),
				}
			}
			visitorNeedDescriptions[key] =
				executorNeed?.description ?? visitorNeed!.description
		}
	}
	return {
		ok: true as const,
		client,
		org: resolved.org,
		savedPackage: resolved.savedPackage,
		redirectUri: safeRedirectUri,
		state: input.query.state,
		codeChallenge: input.query.codeChallenge,
		scopes,
		visitorNeedDescriptions,
		credentialNeeds,
	}
}

function isSameOriginAuthorizePost(request: Request, env: Env) {
	const appOrigin = new URL(getAppBaseUrl({ env, requestUrl: request.url }))
		.origin
	const origin = request.headers.get('Origin')
	if (origin) return origin === appOrigin
	const site = request.headers.get('Sec-Fetch-Site')
	if (site === 'same-origin' || site === 'none') return true
	// Non-browser clients (tests) omit both; require an explicit same-origin
	// Referer when Origin is absent and Sec-Fetch-Site is missing.
	const referer = request.headers.get('Referer')
	if (!referer) return false
	try {
		return new URL(referer).origin === appOrigin
	} catch {
		return false
	}
}

async function loadExecutorNeedConsentData(input: {
	env: Env
	request: Request
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	needs: ReadonlyArray<CredentialNeed>
	scopes: ReadonlyArray<PackageAppOauthScope>
	kodyId: string
}) {
	const needs = input.scopes.flatMap((scope) => {
		if (!scope.startsWith('need:')) return []
		const key = scope.slice('need:'.length)
		const need = input.needs.find(
			(candidate) => candidate.key === key && candidate.supplier === 'executor',
		)
		return need ? [{ need, scope }] : []
	})
	if (needs.length === 0) return []
	const usable = liveUsableCredentials(
		await listUsableCredentials({
			env: input.env,
			request: input.user.request,
		}),
	)
	const candidateIds = new Set(
		needs.flatMap(({ need }) =>
			resolveNeedCandidates(need, usable).options.map(({ id }) => id),
		),
	)
	const usage = new Map<string, { usedByApps: number; recent: string | null }>()
	if (candidateIds.size > 0) {
		const result = await input.env.APP_DB.prepare(
			`SELECT credential.value AS credential_id,
			        COUNT(DISTINCT app_grant.id) AS used_by_apps,
			        MAX(COALESCE(app_grant.last_used_at, app_grant.created_at)) AS recent
			 FROM package_app_grant_credential_mappings AS mapping
			 JOIN package_app_oauth_grants AS app_grant
			   ON app_grant.id = mapping.grant_id AND app_grant.revoked_at IS NULL
			 JOIN json_each(mapping.credential_ids_json) AS credential
			 WHERE app_grant.person_id = ?
			 GROUP BY credential.value`,
		)
			.bind(input.user.mcpUser.userId)
			.all<{
				credential_id: string
				used_by_apps: number
				recent: string | null
			}>()
		for (const row of result.results ?? []) {
			if (candidateIds.has(row.credential_id)) {
				usage.set(row.credential_id, {
					usedByApps: row.used_by_apps,
					recent: row.recent,
				})
			}
		}
	}
	const baseUrl = getAppBaseUrl({
		env: input.env,
		requestUrl: input.request.url,
	})
	return await Promise.all(
		needs.map(async ({ need, scope }) => {
			const credentials = resolveNeedCandidates(need, usable).options
			const ranked = [...credentials].sort((left, right) => {
				const leftUsage = usage.get(left.id)
				const rightUsage = usage.get(right.id)
				return (
					(rightUsage?.usedByApps ?? 0) - (leftUsage?.usedByApps ?? 0) ||
					(rightUsage?.recent ?? '').localeCompare(leftUsage?.recent ?? '') ||
					left.name.localeCompare(right.name)
				)
			})
			const [recommended] = ranked
			const createUrl = await buildNeedCreateUrl({
				db: input.env.APP_DB,
				baseUrl,
				orgSlug: input.user.request.org.slug,
				key: need.key,
				provider: need.provider,
				need,
				packageKodyId: input.kodyId,
			})
			return {
				key: need.key,
				description: need.description,
				required: need.required === true,
				scope,
				credentials: ranked.map((credential) => ({
					id: credential.id,
					name: credential.name,
					usedByApps: usage.get(credential.id)?.usedByApps ?? 0,
				})),
				recommendedCredentialId: recommended?.id ?? null,
				createUrl,
			}
		}),
	)
}

export async function handlePackageAppOauthAuthorizeRequest(
	request: Request,
	env: Env,
	options: { allowConsentSkip?: boolean } = {},
): Promise<Response | { consent: PackageAppOauthConsentLoaderData }> {
	const url = new URL(request.url)
	if (url.pathname !== packageAppOauthPaths.authorize) {
		return new Response('Not found.', { status: 404 })
	}

	const query =
		request.method === 'POST'
			? await (async () => {
					const form = await request.formData()
					return {
						clientIdRaw: String(form.get('client_id') ?? ''),
						redirectUri: String(form.get('redirect_uri') ?? ''),
						state: String(form.get('state') ?? '') || null,
						codeChallenge: String(form.get('code_challenge') ?? ''),
						codeChallengeMethod: String(
							form.get('code_challenge_method') ?? 'S256',
						),
						scopeRaw: String(form.get('scope') ?? ''),
						selectedScopesRaw: form
							.getAll('selected_scopes')
							.map(String)
							.join(' '),
						credentialSelections: Object.fromEntries(
							[...form.entries()]
								.filter(([name]) => name.startsWith('credential_need:'))
								.map(([name, value]) => [
									name.slice('credential_need:'.length),
									String(value),
								]),
						),
						responseType: String(form.get('response_type') ?? 'code'),
						decision: String(form.get('decision') ?? ''),
					}
				})()
			: {
					...readAuthorizeQuery(url),
					decision: '',
				}

	const validated = await parseAndValidateAuthorizeRequest({
		env,
		query,
		requestUrl: request.url,
		request,
	})
	if (!validated.ok) return validated.response

	const user = await readAuthenticatedAppUser(request, env)
	if (!user) {
		return await redirectToLoginWhenUnauthenticated(request, env)
	}

	if (request.method === 'POST') {
		if (!isSameOriginAuthorizePost(request, env)) {
			return new Response('Cross-origin consent posts are not allowed.', {
				status: 403,
				headers: { 'Cache-Control': 'no-store' },
			})
		}
		const chosen = parsePackageAppOauthScopes(query.selectedScopesRaw)
		if (
			chosen.error ||
			!chosen.scopes.every((scope) => validated.scopes.includes(scope))
		) {
			return new Response('Consent request state is invalid.', {
				status: 403,
				headers: { 'Cache-Control': 'no-store' },
			})
		}
		const decision = 'decision' in query ? query.decision : ''
		if (decision === 'deny') {
			return redirectWithError({
				redirectUri: validated.redirectUri,
				state: validated.state,
				error: 'access_denied',
				description: 'The user denied the request.',
			})
		}
		if (decision !== 'approve') {
			return redirectWithError({
				redirectUri: validated.redirectUri,
				state: validated.state,
				error: 'invalid_request',
				description: 'Unknown consent decision.',
			})
		}
		const executorNeeds = await loadExecutorNeedConsentData({
			env,
			request,
			user,
			needs: validated.credentialNeeds,
			scopes: validated.scopes,
			kodyId: validated.client.kodyId,
		})
		const selectedScopes = new Set<PackageAppOauthScope>([
			'profile',
			...chosen.scopes,
		])
		for (const need of executorNeeds) {
			if (need.required) selectedScopes.add(need.scope as PackageAppOauthScope)
		}
		const mappings: Array<{ needKey: string; credentialIds: Array<string> }> =
			[]
		for (const need of executorNeeds) {
			const selectedId =
				query.credentialSelections?.[encodeURIComponent(need.key)] ??
				query.credentialSelections?.[need.key]
			if (!selectedScopes.has(need.scope as PackageAppOauthScope)) {
				mappings.push({ needKey: need.key, credentialIds: [] })
				continue
			}
			if (!selectedId) {
				return new Response(
					`Choose a credential for the ${need.key} need or turn off its optional scope.`,
					{ status: 400, headers: { 'Cache-Control': 'no-store' } },
				)
			}
			if (!need.credentials.some(({ id }) => id === selectedId)) {
				return new Response(
					`The selected credential for ${need.key} is no longer available. Choose another credential.`,
					{ status: 400, headers: { 'Cache-Control': 'no-store' } },
				)
			}
			mappings.push({ needKey: need.key, credentialIds: [selectedId] })
		}
		await upsertPackageAppOauthGrantWithCredentialMappings({
			db: env.APP_DB,
			personId: user.mcpUser.userId,
			orgUsername: validated.client.username,
			kodyId: validated.client.kodyId,
			scopes: [...selectedScopes],
			mappings,
		})
		return await issueCodeAndRedirect({
			env,
			request,
			personId: user.mcpUser.userId,
			username: user.username,
			orgUsername: validated.client.username,
			kodyId: validated.client.kodyId,
			redirectUri: validated.redirectUri,
			codeChallenge: validated.codeChallenge,
			scopes: [...selectedScopes],
			state: validated.state,
			recordGrant: false,
		})
	}

	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new Response('Method not allowed.', { status: 405 })
	}

	const skip = await shouldSkipConsent({
		env,
		personId: user.mcpUser.userId,
		orgUsername: validated.client.username,
		kodyId: validated.client.kodyId,
		ownerId: validated.org.userId,
		appId: validated.savedPackage.id,
		viewer: {
			userId: user.mcpUser.userId,
			username: user.username,
		},
		scopes: validated.scopes,
	})
	if (
		skip &&
		options.allowConsentSkip !== false &&
		url.searchParams.get('prompt') !== 'consent'
	) {
		return await issueCodeAndRedirect({
			env,
			request,
			personId: user.mcpUser.userId,
			username: user.username,
			orgUsername: validated.client.username,
			kodyId: validated.client.kodyId,
			redirectUri: validated.redirectUri,
			codeChallenge: validated.codeChallenge,
			scopes: validated.scopes,
			state: validated.state,
			recordGrant: false,
		})
	}

	const meta = await loadConsentPackageMeta({
		env,
		orgUsername: validated.client.username,
		kodyId: validated.client.kodyId,
	})
	const viewerDisplayName =
		user.displayName ||
		resolveDisplayName({
			email: user.email,
			username: user.username,
		})
	const hiddenFields: Record<string, string> = {
		client_id: validated.client.clientId,
		redirect_uri: validated.redirectUri,
		response_type: 'code',
		code_challenge: validated.codeChallenge,
		code_challenge_method: 'S256',
		scope: validated.scopes.join(' '),
	}
	if (validated.state) hiddenFields.state = validated.state
	const grant = await findLivePackageAppOauthGrant({
		db: env.APP_DB,
		personId: user.mcpUser.userId,
		orgUsername: validated.client.username,
		kodyId: validated.client.kodyId,
	})
	const alreadyAllowed = new Set(grant?.scopes ?? [])
	const requiredScopes: Array<PackageAppOauthScope> = [
		'profile',
		...validated.credentialNeeds
			.filter(
				(need) =>
					need.supplier === 'executor' &&
					need.required === true &&
					validated.scopes.includes(`need:${need.key}`),
			)
			.map((need) => `need:${need.key}` as PackageAppOauthScope),
	]
	const alreadyAllowedScopes = [...alreadyAllowed].filter(
		(scope) =>
			validated.scopes.includes(scope) && !requiredScopes.includes(scope),
	)
	const requiredLabels = packageAppOauthClaimLabels(requiredScopes)
	const optionalScopes = validated.scopes
		.filter(
			(scope) => !requiredScopes.includes(scope) && !alreadyAllowed.has(scope),
		)
		.map((scope) => ({
			scope,
			label:
				packageAppOauthClaimLabels(
					[scope],
					validated.visitorNeedDescriptions,
				).at(-1) ?? scope,
		}))
	const executorNeeds = await loadExecutorNeedConsentData({
		env,
		request,
		user,
		needs: validated.credentialNeeds,
		scopes: validated.scopes,
		kodyId: validated.client.kodyId,
	})

	return {
		consent: {
			ok: true as const,
			packageName: meta.packageName,
			iconUrl: meta.iconUrl,
			publisherDisplayName: meta.publisherDisplayName,
			publisherUsername: validated.client.username,
			appDomain: packageAppOauthAppDomain(validated.redirectUri),
			viewerDisplayName,
			clientId: validated.client.clientId,
			kodyId: validated.client.kodyId,
			redirectUri: validated.redirectUri,
			scopes: [...validated.scopes],
			requiredScopes,
			alreadyAllowedScopes,
			requiredLabels,
			claimLabels: packageAppOauthClaimLabels(
				validated.scopes,
				validated.visitorNeedDescriptions,
			),
			optionalScopes,
			executorNeeds,
			alreadyAllowedLabels: packageAppOauthClaimLabels(
				alreadyAllowedScopes,
				validated.visitorNeedDescriptions,
			).filter((label) => !requiredLabels.includes(label)),
			hiddenFields,
		},
	}
}
