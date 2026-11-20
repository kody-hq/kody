import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import {
	buildSecretHostApprovalUrl,
	buildSecretHostBulkApprovalUrlIfNeeded,
} from '#mcp/secrets/host-approval.ts'
import {
	buildBasicAuthSecretPlaceholderFromReference,
	buildIntegrationTokenPlaceholder,
	buildProviderSecretPlaceholder,
	buildSecretPlaceholder,
	decodeSecretPlaceholderPunctuation,
	formUrlEncodedTexts,
	parseBasicAuthSecretPlaceholders,
	parseIntegrationTokenPlaceholders,
	parseProviderSecretPlaceholders,
	parseSecretPlaceholders,
	replaceSecretPlaceholders,
	replaceSecretPlaceholdersInFormUrlEncoded,
	replaceSecretPlaceholdersInPath,
	type ReferencedBasicAuthSecretPlaceholder,
	type ReferencedProviderSecret,
	type ReferencedSecret,
} from '#mcp/secrets/placeholders.ts'
import {
	batchHasPlaceholders,
	createPlaceholderFillStream,
	type PlaceholderReferenceBatch,
	type PlaceholderStreamBodyFormat,
} from '#mcp/secrets/placeholder-stream-fill.ts'
import { EncodedPlaceholderError } from '#mcp/secrets/encoded-placeholder.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	createHostSecretAccessDeniedBatchMessage,
	createMissingSecretMessage,
	fetchSecretAuthRequiredMessage,
	SecretHostNotApprovedError,
	type HostApprovalEntry,
} from '#mcp/secrets/errors.ts'
import { createUnresolvedSecretMessage } from '#mcp/secrets/unresolved-secret.ts'
import { normalizeHost } from '#mcp/secrets/allowed-hosts.ts'
import type { ResolvedSecret } from '#mcp/secrets/service.ts'
import type { SecretScope } from '#mcp/secrets/types.ts'
import { secretPageOrgSlugFromCaller } from '#mcp/secrets/package-approval-url.ts'
import { SecretProviderHostDeniedError } from '#mcp/secrets/secret-providers/errors.ts'
import {
	assertSecretPlacement,
	SecretPlacementError,
} from '#mcp/secrets/secret-placement.ts'
import {
	secretAuthorityHeaderName,
	storageContextWithSecretAuthority,
} from '#mcp/secrets/secret-authority.ts'
import { verifyPackageSecretRef } from '#mcp/secrets/package-secret-ref.ts'
import {
	credentialFetchPlacementKey,
	type CredentialFetchPlacement,
} from '#worker/credentials/credential-resolver.ts'
import type { CredentialFillSite } from '#worker/credentials/fill-placement.ts'
import {
	auditResolvedFetchPlacements,
	resolveCredential,
} from '#worker/credentials/resolve-credential.ts'
import { assertCredentialUsesDeclared } from '#worker/credentials/credential-need-enforcement.ts'
import { credentialClientHeaderName } from '#worker/credentials/credential-client-header.ts'
import {
	isSealedTokenName,
	openSealedToken,
	type SealedTokenMinter,
	sealedTokenMinter,
	sealedTokenMinterBucket,
} from '#worker/credentials/sealed-token.ts'
import {
	type JwtSignAnyHostCaller,
	recordJwtSignAnyHostDestination,
} from '#worker/credentials/jwt-sign-any-host.ts'
import { pathSegmentEncodedCredentialNames } from '#mcp/secrets/path-segment-encoding-warning.ts'
import { createMissingIntegrationAccessTokenMessage } from '#worker/integrations/credentials.ts'
import { IntegrationHostNotAllowedError } from '#mcp/execute-modules/integration-host-allowlist.ts'
import type { StorageContext } from '#mcp/storage.ts'
import {
	loadPackageAppRunsAs,
	PackageAppRunsAsUnavailableError,
} from '#worker/package-runtime/package-app-authority.ts'
import type { FetchGatewayProps } from '#mcp/fetch-gateway.ts'
import { resolveGatewayPackageStamp } from '#worker/credentials/package-stamp.ts'
import { savedCredentialNeeds } from '#worker/credentials/credential-needs.ts'
import { pickLegacyMappedKey } from '#worker/credentials/legacy-key-pick.ts'
import { credentialResolutionOutcomeForError } from '#worker/credentials/credential-resolution-audit.ts'
import {
	recordLegacyFill,
	type LegacyFillMode,
} from '#worker/credentials/legacy-fill-audit.ts'

/**
 * Request header that disables secret placeholder resolution for one gateway
 * fetch: `x-kody-secret-resolution: off`. The header is stripped before the
 * request leaves the gateway, and any `{{secret:...}}` text passes through
 * literally. Out-of-band by design — only calling code can set a header, so
 * attacker-controlled *data* in a URL or body can never disable resolution.
 * Use it when a third party must receive literal placeholder text (for
 * example, writing config that Kody itself resolves later). `headers-only`
 * still fills header placeholders but sends the URL and body as written, for
 * a body that quotes the syntax (an issue or chat message) on a host the
 * credential allows; without it that text would be filled with the secret.
 * For merely mentioning the syntax in prose, prefer an inert form:
 * angle-bracket markers (`{{secret:<name>}}`,
 * `{{secret/<provider>:<ref>}}`,
 * `{{secret/bwvault:i/<item-uuid>/<field>}}`) or the grammar metavariable
 * token `{{secret/provider:ref}}`. Those never resolve.
 */
export const secretResolutionHeaderName = 'x-kody-secret-resolution'

/**
 * Package apps fill placeholders as their runs-as person. Authority
 * failures throw. Visitor identity stays on `props.request` for usage.
 */
export async function expandAsPackageAppAuthority(input: {
	request: Request
	props: FetchGatewayProps
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const authority = input.props.packageAppAuthority
	if (!authority) return await expandSecretPlaceholders(input)
	const runsAs = await loadPackageAppRunsAs({
		env: input.env,
		scope: authority.scope,
	})
	if (runsAs.status !== 'ready') {
		throw new PackageAppRunsAsUnavailableError(runsAs.reason)
	}
	return await expandSecretPlaceholders({
		...input,
		props: { ...input.props, request: runsAs.request },
	})
}

/** A credential the filling person cannot resolve, as opposed to a bad request or an outage. */
export class GatewayCredentialUnavailableError extends Error {}

export function isPlaceholderAuthorityFailure(error: unknown) {
	return (
		error instanceof GatewayCredentialUnavailableError ||
		error instanceof SecretPlacementError ||
		error instanceof McpCallerError
	)
}

type PlacedPlaceholderSource = {
	text: string
	/** Audit placement (`url` still covers path + query). */
	placement: CredentialFetchPlacement
	/** Precise site for fill-placement observe/enforce. */
	fillSite: CredentialFillSite
}

/**
 * The outbound request with placeholders filled in its headers, URL path and
 * query, and body (streamed chunk-by-chunk, including multipart parts), plus
 * every credential value that went into it so the response can be redacted.
 *
 * `bodyFillDone` settles after the request body stream has been fully filled
 * (or immediately when there is no body fill). Callers must await it before
 * echo-redacting the response so body-only secrets are included.
 */
export async function expandSecretPlaceholders(input: {
	request: Request
	props: FetchGatewayProps
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<{
	request: Request
	substitutedValues: Array<string>
	bodyFillDone: Promise<void>
	/**
	 * True when the caller asked for `redirect: 'follow'` but the expanded
	 * request uses `manual` so a mid-stream body credential can keep redirects
	 * fail-closed. The gateway may still follow when no
	 * credential was filled and the hop does not replay a body.
	 */
	deferRedirectFollow: boolean
	/**
	 * Credential display names whose path fill encoded `/`, `?`, or `#`.
	 * Used to warn on a 4xx; never includes values.
	 */
	pathSegmentEncodedNames: Array<string>
	/**
	 * Stored secrets this request filled, directly or through a sealed token
	 * minted with them, and their approved hosts.
	 */
	mintedWith: Array<SealedTokenMinter>
	usedLegacyPlaceholders: () => boolean
}> {
	const headers = new Headers(input.request.headers)
	// A client handle is for the gateway only; it never leaves.
	headers.delete(credentialClientHeaderName)
	// Several APIs (GitHub most prominently) reject requests without a
	// User-Agent outright, and workerd sends none by default — bare sandbox
	// fetches hit opaque 403s. Callers that set their own keep it.
	if (!headers.has('user-agent')) {
		headers.set('user-agent', 'kody-agent/1.0')
	}
	const baseUrl = input.props.baseUrl.trim()
	if (!baseUrl) {
		throw new Error('Fetch gateway requires a non-empty baseUrl in props.')
	}
	const packageStamp = resolveGatewayPackageStamp(input.props)
	const storageContext = storageContextWithSecretAuthority(
		input.props.storageContext,
		packageStamp?.packageId ?? null,
	)
	headers.delete(secretAuthorityHeaderName)
	const resolutionMode = readSecretResolutionMode(headers)
	const requestUrl = new URL(
		resolveRequestUrlForFetchGateway(input.request.url, baseUrl),
	)
	const sendBody = shouldSendBody(input.request.method)
	const sourceBody = sendBody ? input.request.body : null

	if (resolutionMode === 'off') {
		return {
			request: new Request(requestUrl, {
				method: input.request.method,
				headers,
				body: sourceBody,
				redirect: input.request.redirect,
				credentials: input.request.credentials,
				mode: input.request.mode,
				cache: input.request.cache,
				integrity: input.request.integrity,
				keepalive: input.request.keepalive,
				signal: input.request.signal,
				...(sourceBody ? { duplex: 'half' as const } : {}),
			}),
			substitutedValues: [],
			bodyFillDone: Promise.resolve(),
			deferRedirectFollow: false,
			pathSegmentEncodedNames: [],
			mintedWith: [],
			usedLegacyPlaceholders: () => false,
		}
	}

	// `headers-only` fills header placeholders and sends the URL and body as
	// written, for a body that quotes the placeholder syntax. That mode
	// intersects with per-credential placement (never widens it): URL/body
	// sources are omitted here, and named-header limits still apply below.
	const fillsUrlAndBody = resolutionMode === 'on'
	const placeholderSources: Array<PlacedPlaceholderSource> = [
		...Array.from(headers.entries(), ([name, text]) => ({
			text,
			placement: { kind: 'header' as const, name },
			fillSite: { part: 'header' as const, name },
		})),
		...(fillsUrlAndBody ? urlPlaceholderSources(requestUrl) : []),
	]
	const metric = (
		props: FetchGatewayProps,
		sites: Parameters<typeof recordLegacyFill>[0]['sites'],
		mode: LegacyFillMode,
		result: Parameters<typeof recordLegacyFill>[0]['result'],
	) =>
		recordLegacyFill({
			env: input.env as Env,
			orgId: props.userId,
			request: props.request,
			packageStamp,
			packageApp: Boolean(props.packageAppAuthority),
			sites,
			mode,
			result,
			waitUntil: input.waitUntil,
		})
	const checkPlacement = (
		sources: ReadonlyArray<PlacedPlaceholderSource>,
		props: FetchGatewayProps,
	) => {
		try {
			assertSecretPlacement({
				url: requestUrl,
				values: sources.map((source) => source.text),
			})
		} catch (error) {
			const authorityHasPlaceholder = holdsPlaceholder(
				decodeSecretPlaceholderPunctuation(
					`${requestUrl.username}:${requestUrl.password}@${requestUrl.host}`,
				),
			)
			metric(
				props,
				authorityHasPlaceholder
					? [{ part: 'url-authority' }]
					: sources
							.filter((source) => holdsPlaceholder(source.text))
							.map((source) => source.fillSite),
				'unknown',
				'denied',
			)
			throw error
		}
	}
	checkPlacement(placeholderSources, input.props)

	const replacements = new Map<string, string>()
	const resolvedValues = new Map<string, string>()
	/** Placeholder → credential display name (never a value). */
	const credentialNamesByPlaceholder = new Map<string, string>()
	const encodedBasicCredentials: Array<string> = []
	const substitutedValues: Array<string> = []
	const mintedWith: Array<SealedTokenMinter> = []
	let referencedAnyCredential = false

	const requestHost = normalizeHost(requestUrl.hostname)
	const auditedPlacementKeys = new Set<string>()

	const placementAuditKey = (
		placeholder: string,
		placement: CredentialFetchPlacement,
	) => `${placeholder}\0${credentialFetchPlacementKey(placement)}`

	const takePendingPlacements = (
		placeholder: string,
		found: ReadonlyArray<CredentialFetchPlacement> | undefined,
	) => {
		if (!found || found.length === 0) return []
		const pending: Array<CredentialFetchPlacement> = []
		const seen = new Set<string>()
		for (const placement of found) {
			const key = placementAuditKey(placeholder, placement)
			if (auditedPlacementKeys.has(key) || seen.has(key)) continue
			seen.add(key)
			switch (placement.kind) {
				case 'header':
					pending.push({
						kind: 'header',
						name: credentialFetchPlacementKey(placement),
					})
					break
				case 'url':
				case 'body':
					pending.push(placement)
					break
				default: {
					const exhaustive: never = placement
					throw new Error(
						`Unhandled credential placement: ${String(exhaustive)}`,
					)
				}
			}
		}
		return pending
	}

	const markPlacementsAudited = (
		placeholder: string,
		placements: ReadonlyArray<CredentialFetchPlacement>,
	) => {
		for (const placement of placements) {
			auditedPlacementKeys.add(placementAuditKey(placeholder, placement))
		}
	}

	const applyBasicAuthPlaceholders = (
		placeholders: ReadonlyArray<ReferencedBasicAuthSecretPlaceholder>,
	) => {
		for (const placeholder of placeholders) {
			const renderedPlaceholder =
				buildBasicAuthSecretPlaceholderFromReference(placeholder)
			const authHeader = buildBasicAuthHeader({
				username: readResolvedSecretValue(resolvedValues, placeholder.username),
				password: readResolvedSecretValue(resolvedValues, placeholder.password),
			})
			encodedBasicCredentials.push(authHeader.slice('Basic '.length))
			// Full header and credential fragment: remotes may echo either.
			substitutedValues.push(authHeader, authHeader.slice('Basic '.length))
			for (const scheme of ['Basic', 'basic', 'BASIC'] as const) {
				const prefixedPlaceholder = `${scheme} ${renderedPlaceholder}`
				if (!replacements.has(prefixedPlaceholder)) {
					replacements.set(prefixedPlaceholder, authHeader)
				}
			}
			if (!replacements.has(renderedPlaceholder)) {
				replacements.set(renderedPlaceholder, authHeader)
			}
		}
	}

	const resolvePlaceholderBatch = async (
		sources: ReadonlyArray<PlacedPlaceholderSource>,
		batchProps: FetchGatewayProps = input.props,
	): Promise<void> => {
		const texts = sources.map((source) => source.text)
		const placementsByPlaceholder = new Map<
			string,
			Array<CredentialFetchPlacement>
		>()
		const fillSitesByPlaceholder = new Map<string, Array<CredentialFillSite>>()
		const notePlacement = (
			placeholder: string,
			placement: CredentialFetchPlacement,
			fillSite: CredentialFillSite,
		) => {
			const found = placementsByPlaceholder.get(placeholder)
			if (found) found.push(placement)
			else placementsByPlaceholder.set(placeholder, [placement])
			const sites = fillSitesByPlaceholder.get(placeholder)
			if (sites) sites.push(fillSite)
			else fillSitesByPlaceholder.set(placeholder, [fillSite])
		}
		for (const source of sources) {
			for (const secret of parseSecretPlaceholders(source.text)) {
				notePlacement(
					buildSecretPlaceholder(secret),
					source.placement,
					source.fillSite,
				)
			}
			for (const basic of parseBasicAuthSecretPlaceholders(source.text)) {
				notePlacement(
					buildSecretPlaceholder(basic.username),
					source.placement,
					source.fillSite,
				)
				notePlacement(
					buildSecretPlaceholder(basic.password),
					source.placement,
					source.fillSite,
				)
			}
			for (const name of parseIntegrationTokenPlaceholders(source.text)) {
				notePlacement(
					buildIntegrationTokenPlaceholder(name),
					source.placement,
					source.fillSite,
				)
			}
			for (const referenced of parseProviderSecretPlaceholders(source.text)) {
				notePlacement(
					buildProviderSecretPlaceholder(referenced),
					source.placement,
					source.fillSite,
				)
			}
		}
		const basicAuthPlaceholders = dedupeBasicAuthSecretPlaceholders(
			texts.flatMap((value) => parseBasicAuthSecretPlaceholders(value)),
		)
		const referencedSecrets = dedupeReferencedSecrets([
			...texts.flatMap((value) => parseSecretPlaceholders(value)),
			...basicAuthPlaceholders.flatMap((placeholder) => [
				placeholder.username,
				placeholder.password,
			]),
		]).flatMap((referenced) => {
			const placeholder = buildSecretPlaceholder(referenced)
			const placements = takePendingPlacements(
				placeholder,
				placementsByPlaceholder.get(placeholder),
			)
			if (placements.length === 0) return []
			return [
				{
					referenced,
					placeholder,
					credential: {
						use: 'secret' as const,
						name: referenced.name,
						scope: referenced.scope,
						storageContext,
						orgSlug: secretPageOrgSlugFromCaller(batchProps),
						requestHost,
						placements,
						fillSites: fillSitesByPlaceholder.get(placeholder) ?? [],
					},
				},
			]
		})
		const integrationTokenNames = dedupeIntegrationTokenNames(
			texts.flatMap((value) => parseIntegrationTokenPlaceholders(value)),
		)
		for (const name of integrationTokenNames.filter(isSealedTokenName)) {
			const placeholder = buildIntegrationTokenPlaceholder(name)
			if (
				replacements.has(placeholder) ||
				!placementsByPlaceholder.has(placeholder)
			) {
				continue
			}
			const anyHostFill: { caller?: JwtSignAnyHostCaller } = {}
			const opened = await openSealedToken({
				env: input.env,
				name,
				org: requireFetchUserId(batchProps),
				binding: batchProps.credentialClientBinding ?? null,
				requestHost,
				parts: (fillSitesByPlaceholder.get(placeholder) ?? []).map(
					(site) => site.part,
				),
				onAnyHostFill: (caller) => {
					anyHostFill.caller = caller
				},
				// A package or session secret is approved in its own bucket, so
				// only link when this run resolves the minter's bucket.
				hostApprovalUrl: (minter) =>
					minter.bucket ===
					sealedTokenMinterBucket(minter.scope, storageContext)
						? buildSecretHostApprovalUrl({
								baseUrl: batchProps.baseUrl,
								orgSlug: secretPageOrgSlugFromCaller(batchProps),
								name: minter.secret,
								scope: minter.scope,
								requestedHost: requestHost,
								storageContext,
							})
						: undefined,
			})
			const value = opened.value
			mintedWith.push(...opened.mintedWith)
			if (anyHostFill.caller) {
				const recorded = recordJwtSignAnyHostDestination({
					env: input.env,
					caller: anyHostFill.caller,
					host: requestHost,
				})
				if (input.waitUntil) input.waitUntil(recorded)
				else await recorded
			}
			referencedAnyCredential = true
			credentialNamesByPlaceholder.set(placeholder, 'sealed token')
			replacements.set(placeholder, value)
			substitutedValues.push(value)
		}
		const referencedIntegrationTokens = integrationTokenNames
			.filter((name) => !isSealedTokenName(name))
			.flatMap((name) => {
				const placeholder = buildIntegrationTokenPlaceholder(name)
				const placements = takePendingPlacements(
					placeholder,
					placementsByPlaceholder.get(placeholder),
				)
				if (placements.length === 0) return []
				return [
					{
						name,
						placeholder,
						credential: {
							use: 'integration-token' as const,
							name,
							requestHost,
							placements,
							fillSites: fillSitesByPlaceholder.get(placeholder) ?? [],
						},
					},
				]
			})
		const referencedProviderSecrets = dedupeReferencedProviderSecrets(
			texts.flatMap((value) => parseProviderSecretPlaceholders(value)),
		).flatMap((referenced) => {
			const placeholder = buildProviderSecretPlaceholder(referenced)
			const placements = takePendingPlacements(
				placeholder,
				placementsByPlaceholder.get(placeholder),
			)
			if (placements.length === 0) return []
			return [
				{
					referenced,
					placeholder,
					credential: {
						use: 'provider-secret' as const,
						provider: referenced.provider,
						ref: referenced.ref,
						storageContext,
						requestHost,
						placements,
						fillSites: fillSitesByPlaceholder.get(placeholder) ?? [],
					},
				},
			]
		})
		const pendingBasicAuth = basicAuthPlaceholders.filter((placeholder) => {
			const rendered = buildBasicAuthSecretPlaceholderFromReference(placeholder)
			return !replacements.has(rendered)
		})
		if (
			referencedSecrets.length === 0 &&
			referencedIntegrationTokens.length === 0 &&
			referencedProviderSecrets.length === 0 &&
			pendingBasicAuth.length === 0
		) {
			return
		}
		referencedAnyCredential = true
		checkPlacement(sources, batchProps)
		const callerUserId = requireFetchUserId(batchProps)
		const resolveInput = {
			env: input.env as Env,
			orgId: callerUserId,
			actor: batchProps.request,
			packageStamp,
			baseUrl: batchProps.baseUrl,
			// Run package id for the nested personal-secret rule (GHSA-5fv3).
			runContextPackageId:
				packageStamp?.kind === 'claimed'
					? undefined
					: (batchProps.storageContext?.packageId ?? null),
		}
		const entriesToResolve = <
			T extends {
				placeholder: string
				credential: Parameters<typeof resolveCredential>[0]['credential']
			},
		>(
			entries: ReadonlyArray<T>,
		) =>
			entries.flatMap((entry) => {
				const placements =
					'placements' in entry.credential
						? entry.credential.placements
						: undefined
				markPlacementsAudited(entry.placeholder, placements ?? [])
				if (
					!replacements.has(entry.placeholder) ||
					!auditResolvedFetchPlacements({
						...resolveInput,
						credential: entry.credential,
					})
				) {
					return [entry]
				}
				return []
			})
		const secretsToResolve = entriesToResolve(referencedSecrets)
		const integrationTokensToResolve = entriesToResolve(
			referencedIntegrationTokens,
		)
		const providerSecretsToResolve = entriesToResolve(referencedProviderSecrets)
		const declaredNeeds = await assertCredentialUsesDeclared({
			env: input.env as Env,
			request: batchProps.request,
			orgId: callerUserId,
			packageId: packageStamp?.packageId ?? null,
			references: [
				...referencedSecrets.map((entry) => ({
					use: 'secret' as const,
					name: entry.referenced.name,
					scope: entry.referenced.scope,
				})),
				...referencedIntegrationTokens.map((entry) => ({
					use: 'integration' as const,
					name: entry.name,
				})),
				...referencedProviderSecrets.map((entry) => ({
					use: 'provider' as const,
					provider: entry.referenced.provider,
				})),
			],
		}).catch((error: unknown) => {
			metric(
				batchProps,
				sources
					.filter((source) => holdsPlaceholder(source.text))
					.map((source) => source.fillSite),
				'unknown',
				'denied',
			)
			throw error
		})
		const declaredSavedNeeds = new Map(
			savedCredentialNeeds([...declaredNeeds.values()]).map((need) => [
				need.key,
				need,
			]),
		)
		const settledSecretResults = await Promise.allSettled(
			secretsToResolve.map(async ({ referenced, credential }) => {
				// Package-scoped placeholders issued by packageSecrets.get carry a
				// per-run HMAC bound to the declaring package (GHSA-5fv3). A stolen
				// placeholder cannot be filled under another package's authority.
				if (
					referenced.scope === 'package' &&
					referenced.ref &&
					batchProps.packageSecretRefKey
				) {
					const authorityId = packageStamp?.packageId ?? null
					const ok =
						authorityId != null &&
						(await verifyPackageSecretRef({
							refKey: batchProps.packageSecretRefKey,
							packageId: authorityId,
							alias: referenced.name,
							ref: referenced.ref,
						}))
					if (!ok) {
						throw new McpCallerError(
							`Package-scoped secret "${referenced.name}" was not issued for this package runtime.`,
						)
					}
				} else if (
					referenced.scope === 'package' &&
					referenced.ref &&
					!batchProps.packageSecretRefKey
				) {
					throw new McpCallerError(
						`Package-scoped secret "${referenced.name}" requires a package runtime that issues secret refs.`,
					)
				}
				const credentialId =
					batchProps.userId === batchProps.request?.org.id
						? await pickLegacyMappedKey({
								env: resolveInput.env,
								request: batchProps.request ?? null,
								legacyCredentialPicks: batchProps.legacyCredentialPicks,
								packageApp: Boolean(batchProps.packageAppAuthority),
								packageId: packageStamp?.packageId ?? null,
								reference: referenced,
								declaredNeed: declaredSavedNeeds.get(referenced.name),
							}).catch((error: unknown) => {
								metric(
									batchProps,
									credential.fillSites,
									'need',
									credentialResolutionOutcomeForError(error).result,
								)
								throw error
							})
						: null
				const mode = credentialId ? 'need' : 'name'
				const resolved = await resolveCredential({
					...resolveInput,
					credential: credentialId
						? { ...credential, credentialId }
						: credential,
					auditDetails: { legacyResolution: mode },
				}).catch((error: unknown) => {
					metric(
						batchProps,
						credential.fillSites,
						mode,
						credentialResolutionOutcomeForError(error).result,
					)
					throw error
				})
				if (!resolved.found || typeof resolved.value !== 'string') {
					metric(batchProps, credential.fillSites, mode, 'failure')
					throw new McpCallerError(
						await createUnresolvedSecretMessage({
							env: input.env,
							userId: callerUserId,
							name: referenced.name,
							scope: referenced.scope,
							storageContext,
							baseUrl: batchProps.baseUrl,
						}),
					)
				}
				metric(batchProps, credential.fillSites, mode, 'success')
				return { referenced, resolved, value: resolved.value }
			}),
		)
		const resolvedSecretResults = readSettledSecretResults({
			settled: settledSecretResults,
			props: batchProps,
			storageContext,
			requestedHost: requestUrl.hostname,
		})
		const resolvedIntegrationTokens = await Promise.all(
			integrationTokensToResolve.map(async ({ name, credential }) => {
				const value = await resolveCredential({
					...resolveInput,
					credential,
				}).catch((error: unknown) => {
					metric(
						batchProps,
						credential.fillSites,
						'integration',
						credentialResolutionOutcomeForError(error).result,
					)
					throw error instanceof IntegrationHostNotAllowedError
						? new SecretPlacementError(error.message, name)
						: error
				})
				if (!value) {
					metric(batchProps, credential.fillSites, 'integration', 'failure')
					throw new GatewayCredentialUnavailableError(
						createMissingIntegrationAccessTokenMessage(name),
					)
				}
				metric(batchProps, credential.fillSites, 'integration', 'success')
				return { name, value }
			}),
		)
		const resolvedProviderSecrets = await Promise.all(
			providerSecretsToResolve.map(async ({ referenced, credential }) => {
				const request = batchProps.request
				if (!request) {
					metric(batchProps, credential.fillSites, 'provider', 'denied')
					throw new GatewayCredentialUnavailableError(
						fetchSecretAuthRequiredMessage,
					)
				}
				const resolved = await resolveCredential({
					...resolveInput,
					actor: request,
					credential,
				}).catch((error: unknown) => {
					metric(
						batchProps,
						credential.fillSites,
						'provider',
						credentialResolutionOutcomeForError(error).result,
					)
					throw error instanceof SecretProviderHostDeniedError
						? new SecretPlacementError(error.message, null)
						: error
				})
				metric(batchProps, credential.fillSites, 'provider', 'success')
				return { referenced, resolved }
			}),
		)
		for (const { referenced, resolved, value } of resolvedSecretResults) {
			mintedWith.push(
				sealedTokenMinter({
					secret: referenced.name,
					scope: resolved.scope ?? referenced.scope ?? 'user',
					hosts: resolved.allowedHosts,
					storageContext,
				}),
			)
			const placeholder = buildSecretPlaceholder(referenced)
			credentialNamesByPlaceholder.set(placeholder, referenced.name)
			if (!replacements.has(placeholder)) {
				replacements.set(placeholder, value)
				substitutedValues.push(value)
			}
			if (!resolvedValues.has(placeholder)) {
				resolvedValues.set(placeholder, value)
			}
		}
		for (const { name, value } of resolvedIntegrationTokens) {
			const placeholder = buildIntegrationTokenPlaceholder(name)
			credentialNamesByPlaceholder.set(placeholder, name)
			if (!replacements.has(placeholder)) {
				replacements.set(placeholder, value)
				substitutedValues.push(value)
			}
		}
		for (const { referenced, resolved } of resolvedProviderSecrets) {
			const placeholder = buildProviderSecretPlaceholder(referenced)
			credentialNamesByPlaceholder.set(
				placeholder,
				`${referenced.provider}:${referenced.ref}`,
			)
			if (!replacements.has(placeholder)) {
				replacements.set(placeholder, resolved.value)
				substitutedValues.push(resolved.value)
			}
		}
		applyBasicAuthPlaceholders(pendingBasicAuth)
	}

	await resolvePlaceholderBatch(placeholderSources)

	for (const [key, value] of Array.from(headers.entries())) {
		headers.set(key, replaceSecretPlaceholders(value, replacements))
	}
	const pathSegmentEncodedNames = fillsUrlAndBody
		? pathSegmentEncodedCredentialNames({
				pathname: decodeSecretPlaceholderPunctuation(requestUrl.pathname),
				replacements,
				credentialNames: credentialNamesByPlaceholder,
			})
		: []
	const nextUrl = fillsUrlAndBody
		? fillUrlPlaceholders(requestUrl, replacements)
		: requestUrl

	let nextBody: ReadableStream<Uint8Array> | null = sourceBody
	let bodyFillDone: Promise<void> = Promise.resolve()
	let bodyFillActive = false

	if (fillsUrlAndBody && sourceBody) {
		bodyFillActive = true
		const { format, body: classifiedBody } = await classifyStreamingBody({
			body: sourceBody,
			contentType: headers.get('content-type'),
		})
		const fill = createPlaceholderFillStream({
			source: classifiedBody,
			format,
			replacements,
			allowPercentEncoded: format === 'form',
			resolve: async (batch: PlaceholderReferenceBatch) => {
				if (!batchHasPlaceholders(batch)) return []
				const placement = { kind: 'body' as const }
				const fillSite = { part: 'body' as const }
				const sources = [
					...batch.secrets.map((secret) => ({
						text: buildSecretPlaceholder(secret),
						placement,
						fillSite,
					})),
					...batch.basicAuth.map((placeholder) => ({
						text: buildBasicAuthSecretPlaceholderFromReference(placeholder),
						placement,
						fillSite,
					})),
					...batch.integrationTokens.map((name) => ({
						text: buildIntegrationTokenPlaceholder(name),
						placement,
						fillSite,
					})),
					...batch.providerSecrets.map((referenced) => ({
						text: buildProviderSecretPlaceholder(referenced),
						placement,
						fillSite,
					})),
				]
				const before = substitutedValues.length
				await resolvePlaceholderBatch(sources)
				return substitutedValues.slice(before)
			},
		})
		nextBody = fill.stream
		bodyFillDone = fill.done.then(() => {
			for (const value of fill.substitutedValues) {
				if (!substitutedValues.includes(value)) {
					substitutedValues.push(value)
				}
			}
		})
		// A body-fill denial also errors the request stream, so the upstream
		// fetch rejects before the caller reaches `await bodyFillDone`. Mark the
		// derived promise handled; callers that do await it still see the error.
		bodyFillDone.catch(() => {})
		// Body length may change as placeholders fill.
		headers.delete('content-length')
	} else if (resolutionMode === 'headers-only') {
		nextBody = sourceBody
	}

	// Any fillable body uses manual redirects so a credential that appears
	// only in a later chunk cannot ride redirect=follow to another host.
	// executeGatewayFetch restores ordinary follow when nothing was filled.
	const deferRedirectFollow =
		input.request.redirect === 'follow' &&
		(referencedAnyCredential || bodyFillActive)
	const nextRedirect = deferRedirectFollow ? 'manual' : input.request.redirect
	return {
		request: new Request(nextUrl, {
			method: input.request.method,
			headers,
			body: nextBody,
			redirect: nextRedirect,
			credentials: input.request.credentials,
			mode: input.request.mode,
			cache: input.request.cache,
			integrity: input.request.integrity,
			keepalive: input.request.keepalive,
			signal: input.request.signal,
			...(nextBody ? { duplex: 'half' as const } : {}),
		}),
		substitutedValues,
		bodyFillDone,
		deferRedirectFollow,
		pathSegmentEncodedNames,
		mintedWith,
		usedLegacyPlaceholders: () => referencedAnyCredential,
	}
}

export function asCallerFacingBodyFillError(error: unknown) {
	if (error instanceof EncodedPlaceholderError) {
		return new McpCallerError(error.message, { cause: error })
	}
	return error
}

function bodyFormatFromContentType(
	contentType: string | null,
): PlaceholderStreamBodyFormat {
	const raw = contentType?.toLowerCase() ?? ''
	if (raw.startsWith('multipart/')) return 'multipart'
	if (raw.startsWith('application/x-www-form-urlencoded')) return 'form'
	const mediaType = raw.split(';')[0]?.trim() ?? ''
	if (mediaType === 'application/json' || mediaType.endsWith('+json')) {
		return 'json'
	}
	return 'text'
}

/**
 * `fetch(url, { body: JSON.stringify(...) })` without a Content-Type is sent
 * as `text/plain`. Peek a small prefix so those bodies still JSON-escape,
 * then rebuild a stream that starts with the peeked bytes (pull-driven so the
 * rest of a large upload stays backpressured).
 */
async function classifyStreamingBody(input: {
	body: ReadableStream<Uint8Array>
	contentType: string | null
}): Promise<{
	format: PlaceholderStreamBodyFormat
	body: ReadableStream<Uint8Array>
}> {
	const hinted = bodyFormatFromContentType(input.contentType)
	const mediaType = input.contentType?.toLowerCase().split(';')[0]?.trim() ?? ''
	const mayBeUntypedJson = mediaType === '' || mediaType === 'text/plain'
	if (hinted !== 'text' || !mayBeUntypedJson) {
		return { format: hinted, body: input.body }
	}
	const reader = input.body.getReader()
	const first = await reader.read()
	if (first.done || !first.value) {
		reader.releaseLock()
		return {
			format: 'text',
			body: new ReadableStream({
				start(c) {
					c.close()
				},
			}),
		}
	}
	const prefix = first.value
	let format: PlaceholderStreamBodyFormat = 'text'
	try {
		const text = new TextDecoder('utf-8', { fatal: true }).decode(prefix)
		JSON.parse(text)
		format = 'json'
	} catch {
		// Incomplete JSON in the first chunk, or not UTF-8. Opening `{` / `[`
		// still means JSON-escape secrets in later chunks (untyped text/plain
		// JSON bodies often arrive split).
		try {
			const text = new TextDecoder('utf-8', { fatal: true }).decode(prefix)
			const trimmed = text.trimStart()
			if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
				format = 'json'
			}
		} catch {
			format = 'text'
		}
	}
	let emittedPrefix = false
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				if (!emittedPrefix) {
					emittedPrefix = true
					controller.enqueue(prefix)
					return
				}
				const { done, value } = await reader.read()
				if (done) {
					controller.close()
					return
				}
				controller.enqueue(value)
			} catch (error) {
				controller.error(error)
			}
		},
		cancel(reason) {
			return reader.cancel(reason)
		},
	})
	return { format, body }
}

/**
 * Kody runtime / sandboxed fetch may emit path-only URLs (e.g. `/`, `/core/log`).
 * Workers `Request` requires an absolute URL string; resolve against the app origin.
 */
function resolveRequestUrlForFetchGateway(url: string, baseUrl: string) {
	const trimmed = url.trim()
	if (!trimmed) {
		throw new Error('Fetch gateway received an empty request URL.')
	}
	try {
		return new URL(trimmed).toString()
	} catch {
		try {
			return new URL(trimmed, baseUrl).toString()
		} catch {
			throw new Error(
				`Fetch gateway could not resolve request URL "${trimmed}" against baseUrl.`,
			)
		}
	}
}

type MissingHostApproval = HostApprovalEntry & {
	scope: SecretScope
	orgSlug: string | null
}

type ResolvedSecretResult = {
	referenced: ReferencedSecret
	resolved: ResolvedSecret
	value: string
}

/**
 * Door host denials are collected into one batch message, so every missing
 * approval is listed at once. Any other failure is rethrown first.
 */
function readSettledSecretResults(input: {
	settled: Array<PromiseSettledResult<ResolvedSecretResult>>
	props: FetchGatewayProps
	storageContext: StorageContext
	requestedHost: string
}) {
	const results: Array<ResolvedSecretResult> = []
	const hostDenials: Array<SecretHostNotApprovedError> = []
	for (const entry of input.settled) {
		if (entry.status === 'fulfilled') {
			results.push(entry.value)
		} else if (entry.reason instanceof SecretHostNotApprovedError) {
			hostDenials.push(entry.reason)
		} else {
			throw entry.reason
		}
	}
	if (hostDenials.length > 0) {
		throw createHostApprovalBatchError({
			props: input.props,
			storageContext: input.storageContext,
			missingApprovals: hostDenials.map((denial) => ({
				secretName: denial.secretName,
				host: input.requestedHost,
				scope: denial.scope,
				orgSlug: denial.orgSlug,
				approvalUrl: buildSecretHostApprovalUrl({
					baseUrl: input.props.baseUrl,
					orgSlug: denial.orgSlug,
					name: denial.secretName,
					scope: denial.scope,
					requestedHost: input.requestedHost,
					storageContext: input.storageContext,
				}),
			})),
		})
	}
	return results
}

function createHostApprovalBatchError(input: {
	props: FetchGatewayProps
	storageContext: StorageContext
	missingApprovals: Array<MissingHostApproval>
}) {
	const { missingApprovals } = input
	const bulkScope = readBulkHostApprovalScope({
		scopes: missingApprovals.map((entry) => entry.scope),
		storageContext: input.storageContext,
	})
	// One link opens one org's page, so a bulk link needs a single owning org.
	const orgSlugs = new Set(missingApprovals.map((entry) => entry.orgSlug))
	const bulkOrgSlug =
		orgSlugs.size === 1 ? (orgSlugs.values().next().value ?? null) : undefined
	const bulkApprovalUrl =
		bulkScope && bulkOrgSlug !== undefined
			? buildSecretHostBulkApprovalUrlIfNeeded({
					baseUrl: input.props.baseUrl,
					orgSlug: bulkOrgSlug,
					names: missingApprovals.map((entry) => entry.secretName),
					hosts: missingApprovals.map((entry) => entry.host),
					scope: bulkScope.scope,
					storageContext: bulkScope.storageContext,
				})
			: null
	return new SecretPlacementError(
		createHostSecretAccessDeniedBatchMessage(
			missingApprovals.map(({ secretName, host, approvalUrl }) => ({
				secretName,
				host,
				approvalUrl,
			})),
			{ bulkApprovalUrl },
		),
		missingApprovals.length === 1
			? (missingApprovals[0]?.secretName ?? null)
			: null,
	)
}

function readBulkHostApprovalScope(input: {
	scopes: Array<SecretScope>
	storageContext: StorageContext | null
}): { scope: SecretScope; storageContext: StorageContext | null } | null {
	const { scopes } = input
	const unique = new Set(scopes)
	if (unique.size !== 1) return null
	const scope = scopes[0]
	if (!scope) return null
	switch (scope) {
		case 'user':
			return { scope, storageContext: null }
		case 'package':
		case 'session':
			return { scope, storageContext: input.storageContext }
		default: {
			const _exhaustive: never = scope
			return _exhaustive
		}
	}
}

function requireFetchUserId(props: FetchGatewayProps): OwnerId {
	if (!props.userId) {
		throw new GatewayCredentialUnavailableError(fetchSecretAuthRequiredMessage)
	}
	return props.userId
}

/**
 * Read and strip the resolution opt-out header. Unknown values fail loudly:
 * a typo like "of" silently resolving placeholders would defeat the point of
 * opting out.
 */
function readSecretResolutionMode(
	headers: Headers,
): 'on' | 'headers-only' | 'off' {
	const raw = headers.get(secretResolutionHeaderName)
	if (raw == null) return 'on'
	headers.delete(secretResolutionHeaderName)
	const value = raw.trim().toLowerCase()
	if (value === 'off') return 'off'
	if (value === 'headers-only') return 'headers-only'
	if (value === 'on') return 'on'
	throw new Error(
		`Invalid ${secretResolutionHeaderName} header value "${raw}". Use "off" to send secret placeholders literally without resolution, "headers-only" to fill header placeholders and send the URL and body as written, or omit the header to fill placeholders anywhere in the request.`,
	)
}

function dedupeReferencedProviderSecrets(
	referenced: Array<ReferencedProviderSecret>,
) {
	const deduped = new Map<string, ReferencedProviderSecret>()
	for (const entry of referenced) {
		deduped.set(buildProviderSecretPlaceholder(entry), entry)
	}
	return Array.from(deduped.values())
}

function dedupeIntegrationTokenNames(names: Array<string>) {
	return Array.from(new Set(names.filter((name) => name.trim().length > 0)))
}

function dedupeReferencedSecrets(referencedSecrets: Array<ReferencedSecret>) {
	const deduped = new Map<string, ReferencedSecret>()
	for (const referenced of referencedSecrets) {
		deduped.set(buildSecretPlaceholder(referenced), referenced)
	}
	return Array.from(deduped.values())
}

function dedupeBasicAuthSecretPlaceholders(
	placeholders: Array<ReferencedBasicAuthSecretPlaceholder>,
) {
	const deduped = new Map<string, ReferencedBasicAuthSecretPlaceholder>()
	for (const placeholder of placeholders) {
		deduped.set(
			buildBasicAuthSecretPlaceholderFromReference(placeholder),
			placeholder,
		)
	}
	return Array.from(deduped.values())
}

/** Path and query texts with precise fill sites (audit still uses `url`). */
function urlPlaceholderSources(url: URL): Array<PlacedPlaceholderSource> {
	const auditPlacement = { kind: 'url' as const }
	return [
		{
			text: decodeSecretPlaceholderPunctuation(url.pathname),
			placement: auditPlacement,
			fillSite: { part: 'path' as const },
		},
		...formUrlEncodedTexts(url.search).map((text) => ({
			text,
			placement: auditPlacement,
			fillSite: { part: 'query' as const },
		})),
	]
}

/**
 * `url` with placeholders filled in its path and query. Only the components
 * that hold one change.
 */
function fillUrlPlaceholders(
	url: URL,
	replacements: ReadonlyMap<string, string>,
) {
	const next = new URL(url)
	if (holdsPlaceholder(decodeSecretPlaceholderPunctuation(url.pathname))) {
		next.pathname = replaceSecretPlaceholdersInPath(url.pathname, replacements)
	}
	if (formUrlEncodedTexts(url.search).some(holdsPlaceholder)) {
		next.search = replaceSecretPlaceholdersInFormUrlEncoded(
			url.search.slice(1),
			replacements,
		)
	}
	return next
}

function holdsPlaceholder(value: string) {
	return (
		parseSecretPlaceholders(value).length > 0 ||
		parseBasicAuthSecretPlaceholders(value).length > 0 ||
		parseIntegrationTokenPlaceholders(value).length > 0 ||
		parseProviderSecretPlaceholders(value).length > 0
	)
}

function shouldSendBody(method: string) {
	return method !== 'GET' && method !== 'HEAD'
}

function readResolvedSecretValue(
	resolvedValues: ReadonlyMap<string, string>,
	referenced: ReferencedSecret,
) {
	const placeholder = buildSecretPlaceholder(referenced)
	const value = resolvedValues.get(placeholder)
	if (value == null) {
		throw new GatewayCredentialUnavailableError(
			createMissingSecretMessage(referenced.name),
		)
	}
	return value
}

function buildBasicAuthHeader(input: { username: string; password: string }) {
	const credentials = new TextEncoder().encode(
		`${input.username}:${input.password}`,
	)
	return `Basic ${bytesToBase64(credentials)}`
}
