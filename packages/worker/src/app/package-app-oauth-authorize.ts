import {
	getAuthSessionExpiresAtMs,
	readParsedAuthSession,
} from '#app/auth-session.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	loadOrgBindingForPerson,
	loadOrgBindingForSlug,
} from '#worker/orgs/repo.ts'
import { decidePackageAppBilling } from '#worker/package-runtime/package-app-billing.ts'
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
import { isCredentialKind } from '#universal/credential-contracts.ts'
import { credentialKindLabel } from '#universal/credentials-list.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { formatUserCode } from '#worker/oauth-device/device-grant.ts'
import {
	decidePackageAppDeviceAuthorization,
	type DeviceAuthorizationRow,
} from '#worker/oauth-device/store.ts'
import { findPendingPackageAppDeviceAuthorization } from '#worker/oauth-device/verification.ts'
import { oauthPaths } from '#universal/oauth-paths.ts'
import {
	packageAppDeviceAuthorizeQuery,
	packageAppDeviceRequester,
} from '#app/package-app-device-request.ts'
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
import {
	isSecretProviderNeed,
	savedCredentialNeeds,
	type SavedCredentialNeed,
} from '#worker/credentials/credential-needs.ts'

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

export type AuthorizeQuery = {
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

export function readAuthorizeQuery(url: URL): AuthorizeQuery {
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

export async function loadConsentPackageMeta(input: {
	env: Env
	orgUsername: string
	kodyId: string
}) {
	let packageName = input.kodyId
	let publisherDisplayName = input.orgUsername
	let iconUrl: string | null = null
	let internetVisible = true
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
				internetVisible = lookup.savedPackage.isInternetVisible
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
	return { packageName, publisherDisplayName, iconUrl, internetVisible }
}

/**
 * Who pays for the visitor's use of the app (ADR 0095). Members of the owning
 * org and every visitor of an internet-visible app: the publisher. Someone
 * from outside the org on an internal app: their own personal org.
 */
async function loadConsentBilling(input: {
	env: Env
	personId: string
	viewerUsername: string
	orgUsername: string
	internetVisible: boolean
}): Promise<NonNullable<PackageAppOauthConsentLoaderData['billing']>> {
	if (input.internetVisible) return { payer: 'publisher' }
	try {
		const binding = await loadOrgBindingForSlug(
			input.env.APP_DB,
			input.personId,
			input.orgUsername,
		)
		if (!binding) return { payer: 'publisher' }
		const personal = await loadOrgBindingForPerson(
			input.env.APP_DB,
			input.personId,
		)
		const billing = decidePackageAppBilling({
			ownerId: binding.org.id,
			visitor: { role: binding.role },
			internetVisible: false,
			visitorPersonalOrgId: personal.org.id,
		})
		if (!billing) return { payer: 'publisher' }
		return {
			payer: 'visitor-org',
			orgSlug: personal.org.slug ?? input.viewerUsername,
		}
	} catch {
		return { payer: 'publisher' }
	}
}

export async function parseAndValidateAuthorizeRequest(input: {
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
	let credentialNeeds: Array<SavedCredentialNeed> = []
	if (needKeys.length > 0) {
		const { manifest } = await loadInvokeManifestBySourceId({
			env: input.env,
			userId: resolved.org.userId,
			sourceId: resolved.savedPackage.sourceId,
		})
		const allCredentialNeeds = await loadPublishedCredentialNeeds({
			env: input.env,
			userId: resolved.org.userId,
			sourceId: resolved.savedPackage.sourceId,
			request: input.request,
		})
		credentialNeeds = savedCredentialNeeds(allCredentialNeeds)
		const declared = manifest.kody.app?.visitorNeeds ?? {}
		for (const key of needKeys) {
			const executorNeed = credentialNeeds.find(
				(need) => need.key === key && need.supplier === 'executor',
			)
			const visitorNeed = Object.hasOwn(declared, key)
				? declared[key]
				: undefined
			const visitorCredentialNeed = visitorNeed?.credential
				? allCredentialNeeds.find((need) => need.key === visitorNeed.credential)
				: undefined
			if (
				visitorCredentialNeed &&
				isSecretProviderNeed(visitorCredentialNeed)
			) {
				return {
					ok: false as const,
					response: redirectWithError({
						redirectUri: safeRedirectUri,
						state: input.query.state,
						error: 'invalid_scope',
						description: `kody.app.visitorNeeds.${key} cannot reference secret-provider credential need "${visitorCredentialNeed.key}".`,
					}),
				}
			}
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

export function isSameOriginAuthorizePost(request: Request, env: Env) {
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
	needs: ReadonlyArray<SavedCredentialNeed>
	scopes: ReadonlyArray<PackageAppOauthScope>
	kodyId: string
	grantId: string | null
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
			resolveNeedCandidates(need, usable).candidates.map(({ id }) => id),
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
	const mappedIds = new Map<string, Array<string>>()
	if (input.grantId) {
		const mapped = await input.env.APP_DB.prepare(
			`SELECT need_key, credential_ids_json
			 FROM package_app_grant_credential_mappings
			 WHERE grant_id = ?`,
		)
			.bind(input.grantId)
			.all<{ need_key: string; credential_ids_json: string }>()
		for (const row of mapped.results ?? []) {
			try {
				const ids: unknown = JSON.parse(row.credential_ids_json)
				if (Array.isArray(ids)) {
					mappedIds.set(
						row.need_key,
						ids.filter((id): id is string => typeof id === 'string'),
					)
				}
			} catch {
				// A malformed row just loses its preselection.
			}
		}
	}
	const baseUrl = getAppBaseUrl({
		env: input.env,
		requestUrl: input.request.url,
	})
	return await Promise.all(
		needs.map(async ({ need, scope }) => {
			// Only credentials for the need's provider; provider-less ones are
			// not offered as matches.
			const credentials = resolveNeedCandidates(need, usable).candidates
			const ranked = [...credentials].sort((left, right) => {
				const leftUsage = usage.get(left.id)
				const rightUsage = usage.get(right.id)
				return (
					(rightUsage?.usedByApps ?? 0) - (leftUsage?.usedByApps ?? 0) ||
					(rightUsage?.recent ?? '').localeCompare(leftUsage?.recent ?? '') ||
					left.name.localeCompare(right.name)
				)
			})
			// Renewed consent keeps the credential this grant already maps.
			const current = ranked.find((credential) =>
				mappedIds.get(need.key)?.includes(credential.id),
			)
			const recommended = current ?? ranked[0]
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
				provider: need.provider,
				kindLabel:
					need.kind && isCredentialKind(need.kind)
						? credentialKindLabel(need.kind)
						: null,
				createDestination: input.user.request.org.slug ?? null,
			}
		}),
	)
}

function seeOther(location: string) {
	return new Response(null, {
		status: 303,
		headers: {
			Location: location,
			'Cache-Control': 'no-store',
			'Referrer-Policy': 'no-referrer',
		},
	})
}

/** Where the approver lands after deciding a device sign-in. */
function deviceResultPath(result: 'approved' | 'denied' | null) {
	return result
		? `${oauthPaths.device}?result=${result}&kind=package_app`
		: `${oauthPaths.device}?error=not_found`
}

function logDeviceDecision(input: {
	env: Env
	request: Request
	user: NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>
	row: DeviceAuthorizationRow
	approved?: boolean
	denied?: boolean
}) {
	const ok = input.approved ?? input.denied ?? false
	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'oauth',
		action: 'device_verify',
		result: ok ? 'success' : 'failure',
		email: input.user.email,
		ip: getRequestIp(input.request) ?? undefined,
		clientId: input.row.client_id,
		reason: ok ? (input.denied ? 'denied' : undefined) : 'not_pending',
	})
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

	const form = request.method === 'POST' ? await request.formData() : null
	const deviceUserCode =
		(form
			? String(form.get('device_user_code') ?? '')
			: (url.searchParams.get('device_user_code') ?? '')
		).trim() || null
	// "Sign in on another device" (ADR 0094): the approver consents here for a
	// limited browser. The request comes from the stored device row, never
	// from the query, and the code is looked up under the `/device` limits.
	let deviceRow: DeviceAuthorizationRow | null = null
	if (deviceUserCode) {
		const approver = await readAuthenticatedAppUser(request, env)
		if (!approver) {
			return await redirectToLoginWhenUnauthenticated(request, env)
		}
		const found = await findPendingPackageAppDeviceAuthorization({
			request,
			env,
			user: { personId: approver.mcpUser.userId, email: approver.email },
			userCode: deviceUserCode,
		})
		if (found.kind !== 'found') {
			const devicePage = new URL(oauthPaths.device, request.url)
			devicePage.searchParams.set('user_code', deviceUserCode)
			devicePage.searchParams.set('error', found.kind)
			return seeOther(`${devicePage.pathname}${devicePage.search}`)
		}
		deviceRow = found.row
	}
	const baseQuery: AuthorizeQuery = deviceRow
		? packageAppDeviceAuthorizeQuery(deviceRow)
		: form
			? {
					clientIdRaw: String(form.get('client_id') ?? ''),
					redirectUri: String(form.get('redirect_uri') ?? ''),
					state: String(form.get('state') ?? '') || null,
					codeChallenge: String(form.get('code_challenge') ?? ''),
					codeChallengeMethod: String(
						form.get('code_challenge_method') ?? 'S256',
					),
					scopeRaw: String(form.get('scope') ?? ''),
					responseType: String(form.get('response_type') ?? 'code'),
				}
			: readAuthorizeQuery(url)
	const query = form
		? {
				...baseQuery,
				selectedScopesRaw: form.getAll('selected_scopes').map(String).join(' '),
				credentialSelections: Object.fromEntries(
					[...form.entries()]
						.filter(([name]) => name.startsWith('credential_need:'))
						.map(([name, value]) => [
							name.slice('credential_need:'.length),
							String(value),
						]),
				),
				decision: String(form.get('decision') ?? ''),
			}
		: { ...baseQuery, decision: '' }

	const validated = await parseAndValidateAuthorizeRequest({
		env,
		query,
		requestUrl: request.url,
		request,
	})
	if (!validated.ok) return validated.response

	const user = await readAuthenticatedAppUser(request, env)
	if (!user) {
		// A limited browser that pressed "Sign in on another device" on a Kody
		// package path comes back here from the app host with a fresh PKCE
		// request (ADR 0094). The intent cookie can only be set by that
		// same-origin POST, and it names this app.
		if (request.method === 'GET' && !deviceRow) {
			const { createPackageAppDeviceSignIn, readPackageAppDeviceIntent } =
				await import('#app/package-app-device-sign-in.ts')
			const intent = await readPackageAppDeviceIntent(request, env)
			if (intent && intent === validated.client.clientId.toLowerCase()) {
				return await createPackageAppDeviceSignIn({
					request,
					env,
					validated,
					clearIntent: true,
				})
			}
		}
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
		if (deviceRow && decision !== 'approve') {
			if (decision !== 'deny') {
				return new Response('Unknown consent decision.', {
					status: 400,
					headers: { 'Cache-Control': 'no-store' },
				})
			}
			const denied = await decidePackageAppDeviceAuthorization(env.APP_DB, {
				id: deviceRow.id,
				decision: 'denied',
				userId: user.mcpUser.userId,
			})
			logDeviceDecision({ env, request, user, row: deviceRow, denied })
			return seeOther(deviceResultPath(denied ? 'denied' : null))
		}
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
			grantId: null,
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
		if (deviceRow) {
			const approved = await decidePackageAppDeviceAuthorization(env.APP_DB, {
				id: deviceRow.id,
				decision: 'approved',
				userId: user.mcpUser.userId,
				approvedScope: [...selectedScopes].join(' '),
			})
			logDeviceDecision({ env, request, user, row: deviceRow, approved })
			return seeOther(deviceResultPath(approved ? 'approved' : null))
		}
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
		!deviceRow &&
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
	const hiddenFields: Record<string, string> = deviceRow
		? { device_user_code: formatUserCode(deviceRow.user_code) }
		: {
				client_id: validated.client.clientId,
				redirect_uri: validated.redirectUri,
				response_type: 'code',
				code_challenge: validated.codeChallenge,
				code_challenge_method: 'S256',
				scope: validated.scopes.join(' '),
			}
	if (validated.state && !deviceRow) hiddenFields.state = validated.state
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
		grantId: grant?.id ?? null,
	})
	const billing = await loadConsentBilling({
		env,
		personId: user.mcpUser.userId,
		viewerUsername: user.username,
		orgUsername: validated.client.username,
		internetVisible: validated.savedPackage.isInternetVisible,
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
			billing,
			device: deviceRow
				? {
						userCode: formatUserCode(deviceRow.user_code),
						requester: packageAppDeviceRequester(deviceRow),
						expiresAt: deviceRow.expires_at,
					}
				: null,
		},
	}
}
