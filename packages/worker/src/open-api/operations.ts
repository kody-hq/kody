import { type SurfacePermission } from '#worker/authorization/authorize.ts'

export const apiOperationMethods = [
	'GET',
	'POST',
	'PUT',
	'PATCH',
	'DELETE',
] as const

export type ApiOperationMethod = (typeof apiOperationMethods)[number]

export const apiOperationTags = [
	'account',
	'search',
	'memories',
	'secrets',
	'packages',
	'follows',
	'repos',
	'jobs',
	'webhooks',
	'email',
	'integrations',
	'mcp-servers',
	'runs',
	'storage',
	'community',
	'tokens',
	'capability-proxy',
	'execute',
] as const

export type ApiOperationTag = (typeof apiOperationTags)[number]

type ApiOperationBase = {
	operationId: string
	method: ApiOperationMethod
	/** OpenAPI path template, e.g. `/v1/packages/{package_id}`. */
	path: string
	tag: ApiOperationTag
}

/**
 * An operation backed by a registry capability. `operationId` is the
 * capability name, inputs are the capability's input schema (path params
 * map to same-named inputs), and its org permission is the capability's
 * `orgPermission`.
 */
export type CapabilityApiOperation = ApiOperationBase & {
	kind: 'capability'
	/** Inputs that cannot be encoded in this method's query string. */
	omitInputs?: ReadonlyArray<string>
	/**
	 * Extra HTTP paths that invoke this same capability. Advertised in
	 * `/openapi.json` with a distinct operationId (`${operationId}ByPath`) so
	 * the document stays unique while legacy path callers keep working.
	 * Prefer putting the body-friendly path on `path` when identity inputs are
	 * XOR (e.g. `repo_id` | `name`).
	 */
	aliasPaths?: ReadonlyArray<string>
}

export const nativeApiOperationIds = [
	'tokenList',
	'tokenCreate',
	'tokenGetCurrent',
	'tokenRotateCurrent',
	'tokenRevokeCurrent',
	'tokenGet',
	'tokenRotate',
	'tokenRevoke',
	'cliCredentialBootstrapRedeem',
	'capabilityProxySession',
	'capabilityProxyCall',
	'capabilityProxyGatewayFetch',
	'localExecutePackageGraph',
	'execute',
	'searchTool',
	'cliLoginDeviceToken',
] as const

export type NativeApiOperationId = (typeof nativeApiOperationIds)[number]

/** An operation implemented directly by the Open API (not a capability). */
export type NativeApiOperation = ApiOperationBase & {
	kind: 'native'
	operationId: NativeApiOperationId
	/** Org permission, published as `x-kody-permission`. */
	permission: SurfacePermission
}

export type ApiOperation = CapabilityApiOperation | NativeApiOperation

type CapabilityRoute = [
	method: ApiOperationMethod,
	path: string,
	capabilityName: string,
	options?: Pick<CapabilityApiOperation, 'omitInputs' | 'aliasPaths'>,
]

function capabilityRoutes(
	tag: ApiOperationTag,
	routes: ReadonlyArray<CapabilityRoute>,
): Array<CapabilityApiOperation> {
	return routes.map(([method, path, operationId, options]) => ({
		kind: 'capability',
		operationId,
		method,
		path,
		tag,
		...options,
	}))
}

function nativeRoute(
	method: ApiOperationMethod,
	path: string,
	operationId: NativeApiOperationId,
	permission: SurfacePermission,
	options: Pick<NativeApiOperation, 'tag'> = { tag: 'tokens' },
): NativeApiOperation {
	return {
		kind: 'native',
		operationId,
		method,
		path,
		permission,
		...options,
	}
}

const capabilityProxyRoute = {
	tag: 'capability-proxy',
} as const

/**
 * Every operation on the Kody Open API (`/v1`). Changes here are public API:
 * add operations freely, but never rename an operationId, change a method or
 * path, or remove an operation without a new version.
 *
 * Deliberately absent: secret plaintext reads, inbound webhook receive,
 * package-app HTTP/WebSocket traffic, admin, and runtime-only capabilities
 * (values, package-app fetch, synthetic dispatch). Hosted execute is
 * `POST /v1/execute` (native). The in-sandbox `execute` capability stays
 * off this list.
 */
export const apiOperations: ReadonlyArray<ApiOperation> = [
	...capabilityRoutes('account', [
		['GET', '/v1/me', 'metaGetCurrentUser'],
		['GET', '/v1/account/usage', 'usageGet'],
		['GET', '/v1/account/usage/trend', 'usageTrendGet'],
		['GET', '/v1/account/usage/by-package', 'usageByPackageGet'],
		['GET', '/v1/account/waiting', 'waitingSummary'],
		['GET', '/v1/account/export', 'accountExportManifest'],
		['GET', '/v1/account/export/{section}', 'accountExportSection'],
		['GET', '/v1/account/feedback', 'metaPlatformFeedbackList'],
		['GET', '/v1/account/feedback/{feedback_id}', 'metaPlatformFeedbackGet'],
		['POST', '/v1/account/feedback', 'metaPlatformFeedbackSubmit'],
		// Teams access (grants, invites, orgs, teams). Tagged account until
		// token scopes move to the org vocabulary (P4/P5).
		['GET', '/v1/access/grants', 'accessList'],
		['POST', '/v1/access/grants', 'accessGrant'],
		['POST', '/v1/access/grants/{grant_id}/revoke', 'accessRevoke'],
		['POST', '/v1/access/invites', 'inviteCreate'],
		['POST', '/v1/access/invites/accept', 'inviteAccept'],
		['POST', '/v1/access/invites/{invite_id}/revoke', 'inviteRevoke'],
		['POST', '/v1/orgs', 'orgCreate'],
		['PATCH', '/v1/orgs', 'orgUpdate'],
		[
			'GET',
			'/v1/orgs/package-app-custom-hostnames',
			'packageAppCustomHostnameList',
		],
		[
			'POST',
			'/v1/orgs/package-app-custom-hostnames',
			'packageAppCustomHostnameAdd',
		],
		[
			'POST',
			'/v1/orgs/package-app-custom-hostnames/{id}/sync',
			'packageAppCustomHostnameSync',
		],
		[
			'DELETE',
			'/v1/orgs/package-app-custom-hostnames/{id}',
			'packageAppCustomHostnameDelete',
		],
		['GET', '/v1/orgs/members', 'orgMemberList'],
		['PATCH', '/v1/orgs/members/{user_id}', 'orgMemberUpdate'],
		['DELETE', '/v1/orgs/members/{user_id}', 'orgMemberRemove'],
		['GET', '/v1/orgs/teams', 'teamList'],
		['POST', '/v1/orgs/teams', 'teamCreate'],
		['POST', '/v1/orgs/teams/{team_id}/members', 'teamMemberAdd'],
		[
			'DELETE',
			'/v1/orgs/teams/{team_id}/members/{user_id}',
			'teamMemberRemove',
		],
	]),
	...capabilityRoutes('search', [
		['GET', '/v1/search', 'search', { omitInputs: ['memoryContext'] }],
	]),
	...capabilityRoutes('memories', [
		['GET', '/v1/memories', 'metaMemorySearch'],
		['POST', '/v1/memories', 'metaMemoryUpsert'],
		['POST', '/v1/memories/verify', 'metaMemoryVerify'],
		['GET', '/v1/memories/{memory_id}', 'metaMemoryGet'],
		['DELETE', '/v1/memories/{memory_id}', 'metaMemoryDelete'],
		['GET', '/v1/mcp-server-instructions', 'metaGetMcpServerInstructions'],
		['PUT', '/v1/mcp-server-instructions', 'metaSetMcpServerInstructions'],
	]),
	...capabilityRoutes('secrets', [
		['GET', '/v1/secrets', 'secretList'],
		['POST', '/v1/secrets/batch', 'secretSetMany'],
		['POST', '/v1/secrets/lock', 'secretLock'],
		['POST', '/v1/secrets/jwt', 'secretJwtSign'],
		['PUT', '/v1/secrets/{scope}/{name}', 'secretSet'],
		['POST', '/v1/secrets/{scope}/{name}/disconnect', 'secretDisconnect'],
		['DELETE', '/v1/secrets/{scope}/{name}', 'secretDelete'],
		['GET', '/v1/credentials', 'credentialList'],
		['PATCH', '/v1/credentials/{credential_id}', 'credentialUpdate'],
		['POST', '/v1/credential-proposals', 'credentialMappingPropose'],
		['GET', '/v1/personal-credential-grants', 'credentialOrgGrantList'],
		[
			'PUT',
			'/v1/personal-credential-grants/{credential_id}/{org}',
			'credentialOrgGrant',
		],
		[
			'DELETE',
			'/v1/personal-credential-grants/{credential_id}/{org}',
			'credentialOrgRevoke',
		],
		['PUT', '/v1/credential-trigger-picks', 'credentialTriggerPickSet'],
		['GET', '/v1/secret-providers', 'secretProviderList'],
		['PUT', '/v1/secret-providers/{provider}', 'secretProviderBind'],
		['DELETE', '/v1/secret-providers/{provider}', 'secretProviderUnbind'],
		['POST', '/v1/secret-providers/{provider}/lock', 'secretProviderLock'],
	]),
	...capabilityRoutes('packages', [
		['GET', '/v1/packages', 'packageList'],
		['POST', '/v1/packages', 'packageSave'],
		['POST', '/v1/packages/check', 'packageCheck'],
		['GET', '/v1/packages/{package_id}', 'packageGet'],
		[
			'GET',
			'/v1/packages/{package_id}/collaborators',
			'packageCollaboratorList',
		],
		[
			'POST',
			'/v1/packages/{package_id}/collaborators',
			'packageCollaboratorSet',
		],
		[
			'DELETE',
			'/v1/packages/{package_id}/collaborators/{grant_id}',
			'packageCollaboratorRemove',
		],
		['PATCH', '/v1/packages/{package_id}', 'packageUpdate'],
		['DELETE', '/v1/packages/{package_id}', 'packageDelete'],
		['POST', '/v1/packages/{package_id}/git-remote', 'packageGetGitRemote'],
		[
			'POST',
			'/v1/packages/{package_id}/security-audits',
			'packageSecurityAuditRecord',
		],
		[
			'POST',
			'/v1/packages/{package_id}/external-push',
			'packagePublishExternalPush',
		],
		['GET', '/v1/package-subscriptions', 'packageSubscriptionsList'],
		['GET', '/v1/enablements', 'enablementList'],
		['POST', '/v1/enablements', 'enablementEnable'],
		['POST', '/v1/enablements/{enablementId}/disable', 'enablementDisable'],
		['GET', '/v1/approvals', 'approvalPendingList'],
		['POST', '/v1/approval-bundles', 'approvalBundleCreate'],
	]),
	...capabilityRoutes('follows', [
		['GET', '/v1/follows', 'followList'],
		['POST', '/v1/follows', 'followAdd'],
		['DELETE', '/v1/follows', 'followRemove'],
	]),
	...capabilityRoutes('repos', [
		['GET', '/v1/repos', 'repoList'],
		['POST', '/v1/repos', 'repoCreate'],
		['GET', '/v1/repos/{repo_id}', 'repoGet'],
		['PATCH', '/v1/repos/{repo_id}', 'repoUpdate'],
		['DELETE', '/v1/repos/{repo_id}', 'repoDelete'],
		[
			'POST',
			'/v1/repos/git-remote',
			'repoGetGitRemote',
			{
				// Preferred body-only path so CLI/OpenAPI can pass `name` or
				// `repo_id` without a path param. Legacy path stays as an HTTP
				// alias (and a distinct OpenAPI operationId) so existing
				// `/v1/repos/{repo_id}/git-remote` callers keep working;
				// `{repo_id}` also accepts a repo name (see resolveOwnedUserRepo).
				aliasPaths: ['/v1/repos/{repo_id}/git-remote'],
			},
		],
		['POST', '/v1/repos/{repo_id}/promote', 'repoPromoteToPackage'],
		['GET', '/v1/repo-publish-note', 'repoShowPublishNote'],
		['GET', '/v1/repo-sessions', 'repoListSessions'],
		['POST', '/v1/repo-sessions', 'repoOpenSession'],
		['GET', '/v1/repo-sessions/{session_id}', 'repoGetSession'],
		['DELETE', '/v1/repo-sessions/{session_id}', 'repoDiscardSession'],
		['GET', '/v1/repo-sessions/{session_id}/status', 'repoStatus'],
		['GET', '/v1/repo-sessions/{session_id}/diff', 'repoDiff'],
		['GET', '/v1/repo-sessions/{session_id}/log', 'repoLog'],
		['GET', '/v1/repo-sessions/{session_id}/tree', 'repoTree'],
		['GET', '/v1/repo-sessions/{session_id}/file', 'repoReadFile'],
		['GET', '/v1/repo-sessions/{session_id}/search', 'repoSearch'],
		['POST', '/v1/repo-sessions/{session_id}/edits', 'repoEditFiles'],
		['POST', '/v1/repo-sessions/{session_id}/patch', 'repoApplyPatch'],
		['POST', '/v1/repo-sessions/{session_id}/restore', 'repoRestore'],
		['POST', '/v1/repo-sessions/{session_id}/commits', 'repoCommit'],
		['GET', '/v1/repo-sessions/{session_id}/checks', 'repoGetCheckStatus'],
		['POST', '/v1/repo-sessions/{session_id}/checks', 'repoRunChecks'],
		['POST', '/v1/repo-sessions/{session_id}/rebase', 'repoRebaseSession'],
		['POST', '/v1/repo-sessions/{session_id}/publish', 'repoPublishSession'],
	]),
	...capabilityRoutes('jobs', [
		['GET', '/v1/jobs', 'jobList'],
		['GET', '/v1/jobs/{id}', 'jobGet'],
		['PATCH', '/v1/jobs/{id}', 'jobUpdate'],
		['POST', '/v1/jobs/{id}/run', 'jobRunNow'],
		['GET', '/v1/workflow-runs', 'workflowRunList'],
		['POST', '/v1/workflow-runs/{id}/cancel', 'workflowRunCancel'],
	]),
	...capabilityRoutes('webhooks', [
		['GET', '/v1/webhooks', 'webhookList'],
		['POST', '/v1/webhooks/apply', 'webhookUrlApply'],
		['POST', '/v1/webhooks/{webhookName}/url', 'webhookUrlMint'],
		['POST', '/v1/webhooks/{webhookName}/url/rotate', 'webhookUrlRotate'],
		['POST', '/v1/webhooks/{webhookName}/enable', 'webhookEnable'],
		['POST', '/v1/webhooks/{webhookName}/disable', 'webhookDisable'],
		['GET', '/v1/webhooks/{webhookName}/deliveries', 'webhookDeliveryList'],
	]),
	...capabilityRoutes('email', [
		['GET', '/v1/email/inboxes', 'emailInboxList'],
		['GET', '/v1/email/messages', 'emailMessageList'],
		['GET', '/v1/email/messages/search', 'emailMessageSearch'],
		['GET', '/v1/email/messages/{message_id}', 'emailMessageGet'],
		['DELETE', '/v1/email/messages/{message_id}', 'emailMessageDelete'],
		[
			'POST',
			'/v1/email/messages/{message_id}/classify',
			'emailMessageClassify',
		],
		['POST', '/v1/email/messages/{message_id}/reply', 'emailReply'],
		['POST', '/v1/email/send', 'emailSend'],
		['GET', '/v1/email/attachments/{attachment_id}', 'emailAttachmentGet'],
		['GET', '/v1/email/delivery-events', 'emailDeliveryEventList'],
		['GET', '/v1/email/sender-rules', 'emailSenderRuleList'],
		['POST', '/v1/email/sender-rules', 'emailSenderRuleSet'],
		['DELETE', '/v1/email/sender-rules/{rule_id}', 'emailSenderRuleDelete'],
		['GET', '/v1/email/destinations', 'emailDestinationList'],
		['POST', '/v1/email/destinations', 'emailDestinationAdd'],
		['DELETE', '/v1/email/destinations/{id}', 'emailDestinationRemove'],
		[
			'POST',
			'/v1/email/destinations/{id}/default',
			'emailDestinationSetDefault',
		],
	]),
	...capabilityRoutes('integrations', [
		['GET', '/v1/integrations', 'integrationList'],
		// Static `device` segments before `/{name}` so path templates stay clear;
		// matchApiRoute also prefers more static segments.
		['POST', '/v1/integrations/device/start', 'integrationDeviceConnectStart'],
		['POST', '/v1/integrations/device/poll', 'integrationDeviceConnectPoll'],
		['GET', '/v1/integrations/{name}', 'integrationGet'],
		['PUT', '/v1/integrations/{name}', 'integrationSave'],
		['DELETE', '/v1/integrations/{name}', 'integrationDelete'],
		['POST', '/v1/integrations/{name}/lock', 'integrationLock'],
		['POST', '/v1/integrations/{name}/refresh', 'integrationTokenRefresh'],
		['GET', '/v1/oauth-apps', 'integrationOauthAppList'],
		['DELETE', '/v1/oauth-apps/{slug}', 'integrationOauthAppDelete'],
		[
			'POST',
			'/v1/oauth-apps/{slug}/rotate-credentials',
			'integrationOauthAppRotateCredentials',
		],
		['GET', '/v1/platform-apps', 'integrationPlatformAppList'],
	]),
	...capabilityRoutes('mcp-servers', [
		['GET', '/v1/mcp-servers', 'mcpServerList'],
		['POST', '/v1/mcp-servers', 'mcpServerAdd'],
		['DELETE', '/v1/mcp-servers/{server}', 'mcpServerRemove'],
		['PUT', '/v1/mcp-servers/{server}/enabled', 'mcpServerSetEnabled'],
		['POST', '/v1/mcp-servers/{server}/reconnect', 'mcpServerReconnect'],
		['POST', '/v1/mcp-servers/{server}/refresh', 'mcpServerRefresh'],
		['POST', '/v1/mcp-servers/{server}/lock', 'mcpServerLock'],
	]),
	...capabilityRoutes('runs', [
		['GET', '/v1/runs', 'runList'],
		['GET', '/v1/runs/summary', 'runSummary'],
		['POST', '/v1/runs/triage', 'runUpdateBulk'],
		['GET', '/v1/runs/{run_id}', 'runGet'],
		['PATCH', '/v1/runs/{run_id}', 'runUpdate'],
	]),
	...capabilityRoutes('storage', [
		['GET', '/v1/storage/{storage_id}/export', 'storageExport'],
		['POST', '/v1/storage/{storage_id}/query', 'storageQuery'],
	]),
	...capabilityRoutes('community', [
		['GET', '/v1/community/listings', 'communitySearch'],
		['POST', '/v1/community/listings', 'communityPublish'],
		['GET', '/v1/community/listings/{listing_id}', 'communityGet'],
		['DELETE', '/v1/community/listings/{listing_id}', 'communityUnpublish'],
		['POST', '/v1/community/listings/{listing_id}/fork', 'communityFork'],
		['POST', '/v1/community/listings/{listing_id}/rate', 'communityRate'],
		['POST', '/v1/community/listings/{listing_id}/report', 'communityReport'],
		['POST', '/v1/community/fork-adopt', 'communityForkAdopt'],
		['GET', '/v1/community/profile', 'communityProfileGet'],
		['PATCH', '/v1/community/profile', 'communityProfileUpdate'],
	]),
	// Own-token create needs no org permission (spec §5.3). List/get/revoke of
	// account tokens require token:read / token:delete so authorize step 4
	// still narrows API-token callers (replaces pre-P4 x-kody-scope).
	nativeRoute('GET', '/v1/tokens', 'tokenList', 'token:read'),
	nativeRoute('POST', '/v1/tokens', 'tokenCreate', 'none'),
	...capabilityRoutes('tokens', [
		['POST', '/v1/tokens/bootstrap', 'cliCredentialBootstrap'],
	]),
	nativeRoute(
		'POST',
		'/v1/tokens/bootstrap/redeem',
		'cliCredentialBootstrapRedeem',
		'none',
	),
	nativeRoute('GET', '/v1/tokens/current', 'tokenGetCurrent', 'none'),
	nativeRoute(
		'POST',
		'/v1/tokens/current/rotate',
		'tokenRotateCurrent',
		'none',
	),
	nativeRoute('DELETE', '/v1/tokens/current', 'tokenRevokeCurrent', 'none'),
	nativeRoute('GET', '/v1/tokens/{token_id}', 'tokenGet', 'token:read'),
	nativeRoute(
		'POST',
		'/v1/tokens/{token_id}/rotate',
		'tokenRotate',
		'token:delete',
	),
	nativeRoute('DELETE', '/v1/tokens/{token_id}', 'tokenRevoke', 'token:delete'),
	nativeRoute(
		'GET',
		'/v1/capability-proxy/session',
		'capabilityProxySession',
		'org:execute',
		capabilityProxyRoute,
	),
	nativeRoute(
		'POST',
		'/v1/capability-proxy/call',
		'capabilityProxyCall',
		'org:execute',
		capabilityProxyRoute,
	),
	nativeRoute(
		'POST',
		'/v1/capability-proxy/gateway-fetch',
		'capabilityProxyGatewayFetch',
		'org:execute',
		capabilityProxyRoute,
	),
	nativeRoute(
		'POST',
		'/v1/local-execute/package-graph',
		'localExecutePackageGraph',
		'org:execute',
		capabilityProxyRoute,
	),
	nativeRoute('POST', '/v1/execute', 'execute', 'org:execute', {
		tag: 'execute',
	}),
	nativeRoute('POST', '/v1/search/tool', 'searchTool', 'search:read', {
		tag: 'search',
	}),
	nativeRoute('POST', '/v1/tokens/device', 'cliLoginDeviceToken', 'none'),
]

export const apiOperationsById: ReadonlyMap<string, ApiOperation> = new Map(
	apiOperations.map((operation) => [operation.operationId, operation]),
)

export function getApiOperationPathParams(path: string) {
	return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!)
}

export function apiOperationUsesQueryInputs(method: ApiOperationMethod) {
	return method === 'GET' || method === 'DELETE'
}

type RouteSegment =
	| { kind: 'static'; value: string }
	| { kind: 'param'; name: string }

type CompiledRoute = {
	operation: ApiOperation
	segments: ReadonlyArray<RouteSegment>
	staticCount: number
}

function compileRoutePath(path: string): {
	segments: Array<RouteSegment>
	staticCount: number
} {
	const segments = path
		.split('/')
		.filter(Boolean)
		.map((segment): RouteSegment => {
			const param = /^\{([^}]+)\}$/.exec(segment)
			return param
				? { kind: 'param', name: param[1]! }
				: { kind: 'static', value: segment }
		})
	return {
		segments,
		staticCount: segments.filter((segment) => segment.kind === 'static').length,
	}
}

/** Primary path plus capability `aliasPaths` (HTTP + OpenAPI). */
export function listApiOperationPaths(operation: ApiOperation): Array<string> {
	const aliasPaths =
		operation.kind === 'capability' ? (operation.aliasPaths ?? []) : []
	return [operation.path, ...aliasPaths]
}

const compiledRoutes: ReadonlyArray<CompiledRoute> = apiOperations.flatMap(
	(operation) =>
		listApiOperationPaths(operation).map((path) => {
			const compiled = compileRoutePath(path)
			return {
				operation,
				segments: compiled.segments,
				staticCount: compiled.staticCount,
			}
		}),
)

function matchRoute(route: CompiledRoute, pathSegments: ReadonlyArray<string>) {
	if (route.segments.length !== pathSegments.length) return null
	const params: Record<string, string> = {}
	for (const [index, segment] of route.segments.entries()) {
		const value = pathSegments[index]!
		if (segment.kind === 'static') {
			if (segment.value !== value) return null
			continue
		}
		let decoded: string
		try {
			decoded = decodeURIComponent(value)
		} catch {
			return null
		}
		if (!decoded) return null
		params[segment.name] = decoded
	}
	return params
}

export type ApiRouteMatch =
	| {
			kind: 'match'
			operation: ApiOperation
			pathParams: Record<string, string>
	  }
	| { kind: 'method_not_allowed'; allow: Array<ApiOperationMethod> }
	| { kind: 'not_found' }

export function isCapabilityProxyGatewayFetchOperation(
	operation: ApiOperation,
): boolean {
	return (
		operation.kind === 'native' &&
		operation.operationId === 'capabilityProxyGatewayFetch'
	)
}

/**
 * Match a request path. Among routes for the request method, the one with
 * the most static segments wins, so `/v1/tokens/current` beats
 * `/v1/tokens/{token_id}`.
 */
export function matchApiRoute(method: string, pathname: string): ApiRouteMatch {
	const pathSegments = pathname.split('/').filter(Boolean)
	const matches = compiledRoutes
		.map((route) => ({ route, params: matchRoute(route, pathSegments) }))
		.filter(
			(
				entry,
			): entry is { route: CompiledRoute; params: Record<string, string> } =>
				entry.params !== null,
		)
	if (matches.length === 0) return { kind: 'not_found' }
	const forMethod = matches
		.filter((entry) => entry.route.operation.method === method)
		.sort((left, right) => right.route.staticCount - left.route.staticCount)
	const best = forMethod[0]
	if (!best) {
		const allow = [
			...new Set(matches.map((entry) => entry.route.operation.method)),
		]
		return { kind: 'method_not_allowed', allow }
	}
	return {
		kind: 'match',
		operation: best.route.operation,
		pathParams: best.params,
	}
}
