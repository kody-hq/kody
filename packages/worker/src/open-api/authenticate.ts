import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import {
	ownerIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import {
	parseApiToken,
	readBearerApiToken,
} from '@kody-internal/shared/api-token-format.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	authenticateApiToken,
	getApiTokenIssuedAtMs,
	slideApiTokenExpiry,
	touchApiToken,
	type ApiTokenAuthenticationFailure,
	type ApiTokenRecord,
} from '#worker/api-tokens/service.ts'
import { loadOrgBindingFromGrantProps } from '#worker/orgs/grant-binding.ts'
import {
	getOrgById,
	getOrgBySlug,
	loadOrgBindingForOrg,
	type OrgBinding,
} from '#worker/orgs/repo.ts'
import { cliClientIdMetadataPath } from '#worker/cli-client-metadata.ts'
import { buildMcpUserContextFromGrantProps } from '#worker/mcp-auth-user-context.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'
import { isCredentialInvalidatedByStoredPasswordChange } from '#worker/password-change-lockout.ts'
import {
	createApiInvocationContext,
	type ApiInvocationContext,
} from './context.ts'
import { ApiError } from './errors.ts'
import { readConnectionProfileNameFromGrantProps } from '#worker/connection-profiles/oauth.ts'
import {
	ecpRunHeader,
	ecpSignatureHeader,
	parseEcpSignatureHeader,
	sha256Base64Url,
} from '@kody-internal/shared/execution-context-protocol/index.ts'
import {
	getExecutionContext,
	loadContextAccess,
	sessionStub,
} from '#worker/execution-contexts/store.ts'
import {
	contextCredentialIds,
	isOperatorContextRun,
	contextRunCredentials,
} from '#worker/execution-contexts/credential-grant.ts'

type McpOauthGrantProps = {
	userId?: unknown
	email?: unknown
	username?: unknown
	displayName?: unknown
	authTime?: unknown
	nonce?: unknown
}

type McpOauthTokenSummary = {
	createdAt: number
	expiresAt: number
	audience?: string | Array<string>
	scope?: Array<string>
	grant: {
		clientId: string
		scope: Array<string>
		props: McpOauthGrantProps
	}
}

type McpOauthHelpers = {
	unwrapToken: (token: string) => Promise<McpOauthTokenSummary | null>
}

function unauthorized(
	message: string,
	invalidToken: boolean,
	meteringUserId?: OwnerId,
) {
	return new ApiError({
		status: 401,
		code: 'unauthorized',
		message,
		headers: {
			'WWW-Authenticate': invalidToken
				? `Bearer realm="kody-api", error="invalid_token"`
				: `Bearer realm="kody-api"`,
		},
		meteringUserId,
	})
}

function describeFailure(reason: ApiTokenAuthenticationFailure) {
	switch (reason) {
		case 'malformed':
		case 'unknown':
			return 'Invalid API token.'
		case 'expired':
			return 'API token expired. Agents on MCP: call cliCredentialBootstrap with lifetime short|long, then `npx @kodycodes/cli auth bootstrap --code …`. CI/headless: mint with tokenCreate.'
		case 'revoked':
			return 'API token was revoked.'
		default: {
			const exhaustive: never = reason
			throw new Error(`Unexpected API token failure: ${String(exhaustive)}`)
		}
	}
}

/**
 * MCP OAuth access tokens are audience-bound to the app origin `/mcp` resource
 * (same check as `mcp-auth.ts`). Local-execute HTTP may accept that class only
 * on CapabilityProxy / package-graph — not as a general Open API bearer.
 */
function mcpOauthAudienceMatches(
	audience: string | Array<string> | undefined,
	appOrigin: string,
) {
	if (!audience) return false
	const allowed = Array.isArray(audience) ? audience : [audience]
	const resourcePath = `${appOrigin}/mcp`
	return allowed.some((value) => value === appOrigin || value === resourcePath)
}

/**
 * Resolve `?org=` for a user-owned token. Accepts a public slug or an org id.
 * Blank/missing defaults to the person's personal org.
 */
export async function resolveOrgBindingForUserOwnedToken(input: {
	db: D1Database
	userId: string
	orgHint: string | null | undefined
}): Promise<OrgBinding | null> {
	const hint = input.orgHint?.trim() ?? ''
	if (!hint) {
		return loadOrgBindingForOrg(input.db, input.userId, input.userId)
	}
	const bySlug = await getOrgBySlug(input.db, hint)
	if (bySlug) {
		return loadOrgBindingForOrg(input.db, input.userId, bySlug.id)
	}
	const byId = await getOrgById(input.db, hint)
	if (byId) {
		return loadOrgBindingForOrg(input.db, input.userId, byId.id)
	}
	return null
}

async function resolveOrgBindingForApiTokenRecord(input: {
	db: D1Database
	userId: string
	record: ApiTokenRecord
	orgHint: string | null | undefined
}): Promise<OrgBinding | null> {
	if (input.record.org_binding === 'user') {
		return resolveOrgBindingForUserOwnedToken({
			db: input.db,
			userId: input.userId,
			orgHint: input.orgHint,
		})
	}
	const orgId = input.record.org_id.trim() || input.record.user_id
	return loadOrgBindingForOrg(input.db, input.userId, orgId)
}

async function authenticateWithApiToken(input: {
	token: string
	env: Env
	appOrigin: string
	waitUntil: (promise: Promise<unknown>) => void
	orgHint?: string | null
}): Promise<ApiInvocationContext> {
	const now = new Date()
	const authentication = await authenticateApiToken({
		db: input.env.APP_DB,
		token: input.token,
		now,
	})
	if (!authentication.ok) {
		throw unauthorized(
			describeFailure(authentication.reason),
			true,
			authentication.record?.user_id
				? ownerIdFromStored(authentication.record.user_id)
				: undefined,
		)
	}
	const { record } = authentication
	const authContext = await buildMcpUserContextFromGrantProps(input.env, {
		userId: record.user_id,
	})
	if (!authContext)
		throw unauthorized(
			'Invalid API token.',
			true,
			ownerIdFromStored(record.user_id),
		)
	if (!authContext.emailVerified) {
		throw new ApiError({
			status: 403,
			code: 'email_verification_required',
			message: `Your account email address is not verified, so API access is disabled. Verify it from ${input.appOrigin}/account.`,
			meteringUserId: personalOrgIdForPerson(authContext.user),
		})
	}
	if (authContext.suspended) {
		throw new ApiError({
			status: 403,
			code: 'account_suspended',
			message:
				'This account is suspended, so API access is disabled. Contact the operator of this Kody deployment to appeal.',
			meteringUserId: personalOrgIdForPerson(authContext.user),
		})
	}
	if (
		isCredentialInvalidatedByStoredPasswordChange({
			issuedAtMs: getApiTokenIssuedAtMs(record),
			storedPasswordChangedAt: authContext.passwordChangedAt,
		})
	) {
		throw unauthorized(
			'API token predates a password change. Mint a new one.',
			true,
			personalOrgIdForPerson(authContext.user),
		)
	}
	const slid = slideApiTokenExpiry(record, now)
	if (slid) {
		input.waitUntil(
			touchApiToken({ db: input.env.APP_DB, record: slid }).catch(
				(error: unknown) => {
					console.warn('api-token-touch-failed', record.id, error)
				},
			),
		)
	}
	const orgBinding = await resolveOrgBindingForApiTokenRecord({
		db: input.env.APP_DB,
		userId: authContext.user.userId,
		record,
		orgHint: input.orgHint,
	})
	if (!orgBinding) {
		throw unauthorized(
			record.org_binding === 'user'
				? 'API token cannot access that org. Pass ?org=<slug> for an org you belong to (or have a grant in), or omit it for your personal org.'
				: 'API token is not bound to an org you can access.',
			true,
			personalOrgIdForPerson(authContext.user),
		)
	}
	return createApiInvocationContext({
		env: input.env,
		callerContext: {
			...createMcpCallerContext({
				baseUrl: input.appOrigin,
				source: { kind: 'api-token', tokenId: record.id },
				executionOrigin: 'interactive',
				user: authContext.user,
				connectionProfileName: record.profile_name ?? null,
				orgBinding,
				scopes: record.scopes,
			}),
			user: authContext.user,
		},
		principal: { kind: 'token', token: slid ?? record },
		waitUntil: input.waitUntil,
	})
}

async function authenticateWithMcpOauth(input: {
	token: string
	env: Env
	appOrigin: string
	waitUntil: (promise: Promise<unknown>) => void
}): Promise<ApiInvocationContext> {
	const helpers = await resolveOAuthHelpers<McpOauthHelpers>(input.env)
	const tokenSummary = helpers ? await helpers.unwrapToken(input.token) : null
	const expectedCliClientId = `${new URL(input.appOrigin).origin}${cliClientIdMetadataPath}`
	if (
		!tokenSummary ||
		!mcpOauthAudienceMatches(tokenSummary.audience, input.appOrigin) ||
		tokenSummary.grant.clientId !== expectedCliClientId
	) {
		throw unauthorized('Invalid API token.', true)
	}
	const authContext = await buildMcpUserContextFromGrantProps(
		input.env,
		tokenSummary.grant.props,
	)
	if (!authContext) {
		throw unauthorized('Invalid API token.', true)
	}
	if (!authContext.emailVerified) {
		throw new ApiError({
			status: 403,
			code: 'email_verification_required',
			message: `Your account email address is not verified, so API access is disabled. Verify it from ${input.appOrigin}/account.`,
			meteringUserId: personalOrgIdForPerson(authContext.user),
		})
	}
	if (authContext.suspended) {
		throw new ApiError({
			status: 403,
			code: 'account_suspended',
			message:
				'This account is suspended, so API access is disabled. Contact the operator of this Kody deployment to appeal.',
			meteringUserId: personalOrgIdForPerson(authContext.user),
		})
	}
	if (
		isCredentialInvalidatedByStoredPasswordChange({
			issuedAtMs: tokenSummary.createdAt * 1000,
			storedPasswordChangedAt: authContext.passwordChangedAt,
		})
	) {
		throw unauthorized(
			'Access token predates a password change. Run kody login again.',
			true,
			personalOrgIdForPerson(authContext.user),
		)
	}
	const grantScopes =
		tokenSummary.scope ??
		(Array.isArray(tokenSummary.grant.scope) ? tokenSummary.grant.scope : [])
	const orgBinding = await loadOrgBindingFromGrantProps({
		db: input.env.APP_DB,
		personId: authContext.user.userId,
		grantProps: tokenSummary.grant.props,
	})
	if (!orgBinding) {
		throw unauthorized(
			'Access token is not bound to an org you can access.',
			true,
			personalOrgIdForPerson(authContext.user),
		)
	}
	return createApiInvocationContext({
		env: input.env,
		callerContext: {
			...createMcpCallerContext({
				baseUrl: input.appOrigin,
				source: { kind: 'cli' },
				executionOrigin: 'interactive',
				user: authContext.user,
				connectionProfileName: readConnectionProfileNameFromGrantProps(
					tokenSummary.grant.props,
				),
				oauthClientId: tokenSummary.grant.clientId,
				orgBinding,
			}),
			user: authContext.user,
		},
		principal: {
			kind: 'mcp-oauth',
			expiresAtUnix: tokenSummary.expiresAt,
			grantScopes,
		},
		waitUntil: input.waitUntil,
	})
}

function leaseDenied(message: string) {
	return new ApiError({
		status: 401,
		code: 'execution_context_lease_invalid',
		message,
	})
}

/**
 * A run on an execution context calling back into Kody (CapabilityProxy and
 * package graph only). The context signs the request; its session checks
 * the signature, nonce, and that `runId` holds a live lease. The requester's
 * account, org binding, and access to the context are then re-read fresh, so
 * a lease never outlives the access it was granted under.
 */
async function authenticateWithExecutionContextLease(input: {
	request: Request
	env: Env
	appOrigin: string
	waitUntil: (promise: Promise<unknown>) => void
	runId: string
}): Promise<ApiInvocationContext> {
	const signature = parseEcpSignatureHeader(
		input.request.headers.get(ecpSignatureHeader),
	)
	if (!signature) {
		throw leaseDenied(`Send ${ecpSignatureHeader} with ${ecpRunHeader}.`)
	}
	const url = new URL(input.request.url)
	const body = new Uint8Array(await input.request.clone().arrayBuffer())
	const session = sessionStub(input.env, signature.ec)
	const verdict = await session.authorizeRunCall({
		runId: input.runId,
		signature,
		method: input.request.method,
		pathAndQuery: `${url.pathname}${url.search}`,
		bodySha256: await sha256Base64Url(body),
	})
	if (!verdict.ok) {
		throw leaseDenied(
			verdict.code === 'lease_ended'
				? 'This run has ended, so it can no longer call Kody.'
				: `Execution context request rejected (${verdict.code}).`,
		)
	}
	const { lease } = verdict
	const accessLost = async (message: string) => {
		input.waitUntil(
			session
				.endLeases({ userIds: [lease.requester.userId], reason: 'access_lost' })
				.catch(() => {}),
		)
		return new ApiError({
			status: 403,
			code: 'execution_context_access_lost',
			message,
		})
	}
	const authContext = await buildMcpUserContextFromGrantProps(input.env, {
		userId: lease.requester.userId,
	})
	if (!authContext || authContext.suspended || !authContext.emailVerified) {
		throw await accessLost('The requester of this run can no longer use Kody.')
	}
	const [orgBinding, context] = await Promise.all([
		loadOrgBindingForOrg(
			input.env.APP_DB,
			authContext.user.userId,
			lease.orgId,
		),
		getExecutionContext(input.env.APP_DB, lease.ecid),
	])
	if (!orgBinding || !context) {
		throw await accessLost(
			'The requester of this run no longer has access to its org.',
		)
	}
	const access = await loadContextAccess(input.env.APP_DB, context, {
		userId: authContext.user.userId,
		orgId: lease.orgId,
	})
	if (!access.usable) {
		throw await accessLost(
			'The requester of this run no longer has access to this execution context.',
		)
	}
	const scopes = lease.callerScopes as ReadonlyArray<OrgPermission> | null
	const identity = {
		operatorUserId: context.operator_user_id,
		requesterUserId: authContext.user.userId,
	}
	const byOperator = isOperatorContextRun(identity)
	const credentials = contextRunCredentials(identity)
	return createApiInvocationContext({
		env: input.env,
		callerContext: {
			...createMcpCallerContext({
				baseUrl: input.appOrigin,
				source: {
					kind: 'execution-context-run',
					ecid: lease.ecid,
					runId: lease.runId,
				},
				executionOrigin: 'interactive',
				user: authContext.user,
				connectionProfileName: null,
				orgBinding,
				scopes,
				contextCredentialIds: contextCredentialIds(credentials),
				contextRunByOperator: byOperator,
			}),
			user: authContext.user,
		},
		principal: {
			kind: 'execution-context-run',
			ecid: lease.ecid,
			runId: lease.runId,
			deadline: lease.deadline,
			scopes: lease.callerScopes,
			runtime: lease.runtime,
			credentials,
			byOperator,
		},
		waitUntil: input.waitUntil,
	})
}

/**
 * Authenticate an Open API request and build the invocation context.
 *
 * Default path: scoped `kody_at_` API tokens (scopes + idle TTL). When
 * `allowMcpOauth` is true (local-execute HTTP surfaces only), a valid MCP /
 * CLI OAuth access token for this app origin is accepted with the full MCP
 * grant — no API-token scope checks. Account gates match `/mcp`: verified
 * email, not suspended, not deleting, and the credential must postdate the
 * last password change. Throws `ApiError` (401/403).
 */
export async function authenticateApiRequest(input: {
	request: Request
	env: Env
	appOrigin: string
	waitUntil: (promise: Promise<unknown>) => void
	/**
	 * When true, accept a valid MCP OAuth access token (CLI `kody login`) for
	 * CapabilityProxy / package-graph. Keep false for every other Open API
	 * route so OAuth stays out of the general credential class (ADR 0053/0055).
	 */
	allowMcpOauth?: boolean
	/**
	 * When true, accept an execution context lease (`Kody-ECP-Run` plus
	 * `Kody-ECP-Signature`) instead of a bearer. CapabilityProxy and package
	 * graph only.
	 */
	allowExecutionContextLease?: boolean
}): Promise<ApiInvocationContext> {
	const runId = input.request.headers.get(ecpRunHeader)
	if (runId) {
		if (!input.allowExecutionContextLease) {
			throw leaseDenied(
				'Execution context runs can only call CapabilityProxy and package graph routes.',
			)
		}
		return authenticateWithExecutionContextLease({ ...input, runId })
	}
	const token = readBearerApiToken(input.request.headers.get('Authorization'))
	if (!token) {
		throw unauthorized(
			'Authentication required. Send Authorization: Bearer <Kody API token>.',
			false,
		)
	}
	if (parseApiToken(token)) {
		const orgHint = new URL(input.request.url).searchParams.get('org')
		return authenticateWithApiToken({
			token,
			env: input.env,
			appOrigin: input.appOrigin,
			waitUntil: input.waitUntil,
			orgHint,
		})
	}
	if (input.allowMcpOauth) {
		return authenticateWithMcpOauth({
			token,
			env: input.env,
			appOrigin: input.appOrigin,
			waitUntil: input.waitUntil,
		})
	}
	throw unauthorized('Invalid API token.', true)
}
