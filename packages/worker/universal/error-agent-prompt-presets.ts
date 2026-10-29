import { normalizeProviderKey } from '@kody-internal/shared/url-hosts.ts'
import {
	buildErrorAgentPrompt,
	redactErrorAgentPromptText,
	type ErrorAgentPromptIds,
} from '#universal/error-agent-prompt.ts'
import {
	codexDcrLoginCommand,
	formatOAuthAuthorizeFailureTime,
	oauthAuthorizeFetchStatusLabel,
	type OAuthAuthorizeClientFailure,
} from '#universal/oauth-authorize-client-failure.ts'

/** Public illustrated 500 — agent cannot see the uncaught failure HTML. */
export function buildInternalErrorAgentPrompt(input: { path?: string | null }) {
	return buildErrorAgentPrompt({
		activity:
			'Opening a Kody page that returned the illustrated internal error (500).',
		errorCode: 'internal_error',
		errorMessage:
			'Something went wrong on our end. The illustrated 500 page was shown.',
		ids: { path: input.path },
		likelyCause:
			'An uncaught server or render failure on kody.codes. The agent does not receive this HTML through MCP/CLI.',
		nextSteps: [
			'Search recent changes and logs for this path if you have them.',
			'Reproduce by opening the same path while signed in as me.',
			'If this is a known package or account action, inspect related runs with runList / runGet.',
		],
		kodyTools: ['runSummary', 'runList', 'runGet'],
		docs: [
			'search({ entity: "guide:how_kody_works" })',
			'search({ entity: "guide:sentry_issues" })',
		],
	})
}

/** Public illustrated 404. */
export function buildNotFoundErrorAgentPrompt(input: { path?: string | null }) {
	return buildErrorAgentPrompt({
		activity:
			'Opening a Kody URL that returned the illustrated not-found page (404).',
		errorCode: 'not_found',
		errorMessage:
			'That address is not a page Kody has. It may have moved, never existed, or a package was unpublished.',
		ids: { path: input.path },
		likelyCause:
			'Wrong URL, unpublished package, or a stale link from an email or agent.',
		nextSteps: [
			'Confirm the path against routes and public package URLs.',
			'If this was a package page, search packages and check whether it was unpublished.',
			'Give me the correct URL or a package install/fork prompt.',
		],
		kodyTools: [
			'search({ entity: "guide:package_lifecycle" })',
			'search({ entity: "guide:packages_integrations_mcp" })',
		],
		docs: [
			'search({ entity: "guide:package_apps" })',
			'search({ entity: "guide:package_lifecycle" })',
		],
	})
}

/** Unauthorized shell fallback. */
export function buildUnauthorizedErrorAgentPrompt(input: {
	path?: string | null
}) {
	return buildErrorAgentPrompt({
		activity: 'Opening a Kody page that returned Unauthorized.',
		errorCode: 'unauthorized',
		errorMessage: 'You are not allowed to view this page.',
		ids: { path: input.path },
		likelyCause:
			'Missing or wrong session, wrong org context, or a page that requires a different role.',
		nextSteps: [
			'Confirm I am signed in as the right user and org.',
			'If this is an org page, check membership and permissions.',
			'Tell me whether to log in, switch org, or request access.',
		],
		kodyTools: [
			'search({ entity: "guide:oauth" })',
			'search({ entity: "guide:organizations" })',
		],
		docs: ['search({ entity: "guide:oauth" })'],
	})
}

/** Org page denied by a missing permission (route 403 explainer). */
export function buildPermissionDeniedErrorAgentPrompt(input: {
	path?: string | null
	message: string
	permission: string | null
	orgSlug: string | null
}) {
	const grantable = input.permission !== null
	return buildErrorAgentPrompt({
		activity: 'Opening a Kody page that returned a permission denial (403).',
		errorCode: 'permission_denied',
		errorMessage: input.message,
		ids: { path: input.path, orgSlug: input.orgSlug },
		likelyCause: grantable
			? `I do not hold the ${input.permission} grant in this organization.`
			: 'My role in this organization does not allow this page.',
		nextSteps: grantable
			? [
					'Check my role in this org with orgMemberList.',
					`Draft the accessGrant request an org Owner would run to grant ${input.permission}.`,
					'Tell me whether to switch org or ask an Owner for access.',
				]
			: [
					'Check my role in this org with orgMemberList.',
					'Tell me which org Owner can change my role with orgMemberUpdate.',
				],
		kodyTools: grantable
			? ['orgMemberList', 'accessGrant']
			: ['orgMemberList', 'orgMemberUpdate'],
		docs: ['search({ entity: "guide:organizations" })'],
	})
}

/** Signed-in visitor opened a package they cannot read (private / no grant). */
export function buildPackageNoAccessErrorAgentPrompt(input: {
	path?: string | null
	packageName: string
	ownerUsername: string
	viewerUsername: string
}) {
	return buildErrorAgentPrompt({
		activity: `Opening ${input.packageName}, which returned the package no-access page (403).`,
		errorCode: 'package_no_access',
		errorMessage: `Signed in as @${input.viewerUsername}, but this account cannot open ${input.packageName}.`,
		ids: { path: input.path, packageName: input.packageName },
		likelyCause:
			'The package exists under the owner org, but this person lacks package:read (package Use) and/or app:execute on the matching app resource. Org membership alone does not include app:execute.',
		nextSteps: [
			`Ask @${input.ownerUsername} to grant Use on package ${input.packageName} (accessGrant resource_type package, preset use) so @${input.viewerUsername} can open the package page.`,
			`For the hosted package app handoff, also grant Use on the app resource with the same package id (accessGrant resource_type app, permissions including app:execute).`,
			'Do not treat this as a missing or unpublished package. Do not assume an org membership invite alone unlocks the app.',
		],
		kodyTools: [
			'search({ entity: "guide:package_sharing" })',
			'search({ entity: "capability:accessGrant" })',
			'search({ entity: "capability:inviteCreate" })',
		],
		docs: ['search({ entity: "guide:package_sharing" })'],
	})
}

export type PackageAppFailureKindForPrompt =
	| 'host-setup'
	| 'package-entrypoint'
	| 'realtime-connect'
	| 'include-used-up'
	| 'runtime-bundle-pending'

/** Package-app visitor HTML failures (kody.run / package subdomain). */
export function buildPackageAppErrorAgentPrompt(input: {
	kind: PackageAppFailureKindForPrompt
	packageName: string
	kodyId: string
	path: string
	cause?: string | null
	runtimeRunId?: string | null
	/** Cloudflare ray of the failed visitor request. */
	rayId?: string | null
}) {
	const titles: Record<PackageAppFailureKindForPrompt, string> = {
		'host-setup': 'Package app could not be prepared',
		'package-entrypoint': 'Package app crashed',
		'realtime-connect': 'Package realtime connection failed',
		'include-used-up': 'Monthly include used up',
		'runtime-bundle-pending': 'Package app is still preparing',
	}
	const causes: Record<PackageAppFailureKindForPrompt, string> = {
		'host-setup':
			'Host could not load or prepare the package app runtime before package code ran.',
		'package-entrypoint':
			'The package app started, but its request handler failed while processing this request.',
		'realtime-connect':
			'Kody could not establish the realtime session for this package app.',
		'include-used-up':
			'This month’s included Pro usage is used up and there are no credits left.',
		'runtime-bundle-pending':
			'The published runtime bundle is not ready yet (common right after a publish while npm dependencies are installed).',
	}
	const nextByKind: Record<PackageAppFailureKindForPrompt, Array<string>> = {
		'host-setup': [
			'Inspect the package source and recent publishes.',
			'Ask the owner to republish if the runtime artifacts are broken.',
			'Retry after checking runList / runGet for related failures.',
		],
		'package-entrypoint': [
			'Open the owning account Activity for this package and runGet the failing run.',
			'Fix the package request handler, then republish.',
		],
		'realtime-connect': [
			'Check package realtime setup and recent app_realtime runs.',
			'Retry the connection after fixing the package if needed.',
		],
		'include-used-up': [
			'Explain how to add credits or wait for the UTC month reset.',
			'Do not invent a bypass for the entitlement limit.',
		],
		'runtime-bundle-pending': [
			'Retry shortly while the post-publish runtime bundle rebuild finishes.',
			'If this persists long after publish, ask the owner to republish so artifacts rebuild.',
		],
	}
	return buildErrorAgentPrompt({
		activity: `Visiting a package app that failed (${input.kind}).`,
		errorCode: `package_app_${input.kind.replaceAll('-', '_')}`,
		errorMessage: titles[input.kind],
		ids: {
			packageName: input.packageName,
			packageKodyId: input.kodyId,
			path: input.path,
			runId: input.runtimeRunId,
			requestId: input.rayId,
		},
		likelyCause: input.cause?.trim()
			? `${causes[input.kind]} Detail: ${input.cause.trim()}`
			: causes[input.kind],
		nextSteps: nextByKind[input.kind],
		kodyTools: [
			'runList',
			'runGet',
			'search({ entity: "guide:package_apps" })',
			'search({ entity: "guide:package_authoring" })',
		],
		docs: ['search({ entity: "guide:package_apps" })'],
	})
}

/** Connect OAuth status callout (callback / token / save failures). */
export function buildConnectOauthFailureAgentPrompt(input: {
	statusMessage: string
	provider?: string | null
	path?: string | null
	connectionName?: string | null
}) {
	return buildErrorAgentPrompt({
		activity: 'Connecting an OAuth integration on /connect/oauth.',
		errorCode: 'connect_oauth_failure',
		errorMessage: input.statusMessage,
		ids: {
			provider: input.provider,
			connectionName: input.connectionName,
			path: input.path ?? '/connect/oauth',
		},
		likelyCause:
			'Missing client credentials, provider error, state mismatch, token exchange failure, or inability to save tokens.',
		nextSteps: [
			'Open guide:oauth and the matching guide:provider_<slug> if one exists.',
			'Confirm authorizeUrl, tokenUrl, client id/secret setup, redirect URI, and scopes.',
			'Give me a corrected /connect/oauth URL or exact UI steps to finish the connect.',
		],
		kodyTools: [
			'search({ entity: "guide:oauth" })',
			'search({ entity: "guide:provider_github" })',
			'integrationList',
		],
		docs: ['search({ entity: "guide:oauth" })'],
	})
}

/** Incomplete /connect/oauth URL (missing authorize/token). */
export function buildIncompleteConnectOauthAgentPrompt(input: {
	provider: string
}) {
	const provider = normalizeProviderKey(input.provider) || 'this provider'
	return buildErrorAgentPrompt({
		activity: `Opened /connect/oauth to connect "${provider}", but the URL is missing authorize and/or token configuration.`,
		errorCode: 'connect_oauth_incomplete_config',
		errorMessage:
			'Kody does not have enough OAuth configuration to start the flow (missing authorize URL and/or token URL).',
		ids: {
			provider,
			path: `/connect/oauth?provider=${encodeURIComponent(provider)}`,
		},
		likelyCause:
			'The connect link was incomplete. Platform menus and bring-your-own flows need authorizeUrl and tokenUrl.',
		nextSteps: [
			'Open search({ entity: "guide:oauth" }) and, if a provider guide exists, search({ entity: "guide:provider_<slug>" }).',
			'Return a complete /connect/oauth URL with provider, authorizeUrl, tokenUrl, and any scopes, flow, and allowedHosts the provider needs.',
		],
		kodyTools: [
			'search({ entity: "guide:oauth" })',
			'search({ entity: "guide:integration_bootstrap" })',
		],
		docs: ['search({ entity: "guide:oauth" })'],
	})
}

/** Human-only secret host / package / webhook / publish approval failures. */
export function buildHumanApprovalErrorAgentPrompt(input: {
	activity: string
	errorMessage: string
	errorCode?: string | null
	ids?: ErrorAgentPromptIds
	likelyCause?: string | null
	docs?: ReadonlyArray<string>
	kodyTools?: ReadonlyArray<string>
	nextSteps?: ReadonlyArray<string>
}) {
	return buildErrorAgentPrompt({
		activity: input.activity,
		errorCode: input.errorCode ?? 'human_approval_error',
		errorMessage: input.errorMessage,
		ids: input.ids,
		likelyCause:
			input.likelyCause ??
			'This is a human-only approval or connect gate. Agents cannot click Allow for the user.',
		nextSteps: input.nextSteps ?? [
			'Explain what I must approve or fix in the browser.',
			'If the request is invalid or expired, tell me how to regenerate a fresh approval link.',
			'Do not claim you can complete the human Allow step yourself.',
		],
		kodyTools: input.kodyTools ?? [
			'search({ entity: "guide:secrets" })',
			'search({ entity: "guide:account_secret_setup" })',
			'secretList',
		],
		docs: input.docs ?? [
			'search({ entity: "guide:secrets" })',
			'search({ entity: "guide:account_secret_setup" })',
		],
	})
}

/** Social login OAuth error codes on /login. */
export function buildOauthLoginErrorAgentPrompt(input: {
	errorCode: string
	errorMessage: string
}) {
	return buildErrorAgentPrompt({
		activity: 'Signing in or connecting a social login provider on /login.',
		errorCode: input.errorCode,
		errorMessage: input.errorMessage,
		ids: { path: '/login' },
		likelyCause:
			'Provider denied access, state mismatch, email claim conflict, or provider configuration issue.',
		nextSteps: [
			'Map the oauthError code to the documented recovery path.',
			'Tell me whether to retry, verify email first, use another provider, or contact support.',
		],
		kodyTools: [
			'search({ entity: "guide:oauth" })',
			'search({ entity: "guide:connect_your_agent" })',
		],
		docs: ['search({ entity: "guide:oauth" })'],
	})
}

/** Billing / payment failure emails and matching billing UI. */
export function buildBillingFailureAgentPrompt(input: {
	kind: 'payment_failed' | 'past_due' | 'budget' | 'checkout'
	errorMessage: string
	orgSlug?: string | null
	path?: string | null
}) {
	return buildErrorAgentPrompt({
		activity:
			'Handling a Kody billing or payment failure from email or the billing UI.',
		errorCode: `billing_${input.kind}`,
		errorMessage: input.errorMessage,
		ids: {
			orgSlug: input.orgSlug,
			path: input.path ?? '/account/billing',
		},
		likelyCause:
			'Stripe could not charge the card, the subscription is past due, an org budget was hit, or checkout could not start.',
		nextSteps: [
			'Explain how to update the payment method on the billing page.',
			'If this is an org budget, explain how to raise or reset the budget.',
			'Do not ask for card numbers or secrets in chat.',
		],
		kodyTools: ['search({ entity: "guide:purchase_thanks" })'],
		docs: ['search({ entity: "guide:organizations" })'],
	})
}

/** MCP inbound OAuth authorize page failures. */
export function buildMcpAuthorizeErrorAgentPrompt(input: {
	errorMessage: string
	path?: string | null
}) {
	return buildErrorAgentPrompt({
		activity: 'Authorizing an MCP client connection in the browser.',
		errorCode: 'mcp_authorize_error',
		errorMessage: input.errorMessage,
		ids: { path: input.path ?? '/oauth/authorize' },
		likelyCause:
			'Provider error, missing org binding, sign-in failure, or consent could not complete.',
		nextSteps: [
			'Explain the authorize/consent steps I must finish in the browser.',
			'If an org picker is required, tell me which org to bind.',
			'Open guide:oauth if the client setup itself is wrong.',
		],
		kodyTools: [
			'search({ entity: "guide:oauth" })',
			'search({ entity: "guide:packages_integrations_mcp" })',
		],
		docs: ['search({ entity: "guide:oauth" })'],
	})
}

/**
 * Authorize page: the OAuth client itself did not resolve (its metadata
 * document could not be fetched, or Kody has no registration for it). The
 * agent reading this is not connected to Kody, so the prompt never points it
 * at Kody tools; it works on the user's machine instead.
 */
export function buildMcpAuthorizeClientFailureAgentPrompt(input: {
	failure: OAuthAuthorizeClientFailure
}) {
	const { failure } = input
	const origin = (failure.kodyOrigin ?? 'https://kody.codes').replace(
		/\/+$/,
		'',
	)
	const mcpUrl = `${origin}/mcp`
	const time = formatOAuthAuthorizeFailureTime(failure.at)
	const lines: Array<string> = []
	if (failure.kind === 'metadata_fetch') {
		const client =
			failure.client === 'codex'
				? `Codex (client metadata at ${failure.host})`
				: failure.client === 'chatgpt'
					? `ChatGPT (client metadata at ${failure.host})`
					: `An MCP client that publishes its client metadata at ${failure.host}`
		lines.push(
			`I tried to connect an MCP client to Kody (${mcpUrl}) and Kody's authorize page said it could not load the client's details.`,
			`Client: ${client}`,
			`What failed: Kody could not download the client's metadata document from ${failure.host} (${oauthAuthorizeFetchStatusLabel(failure)})${time ? ` at ${time}` : ''}. This is a problem on ${failure.host}'s side, not with my Kody account.`,
		)
	} else {
		lines.push(
			`I tried to connect an MCP client to Kody (${mcpUrl}) and Kody's authorize page said it has no registration for this client.`,
			'Client: a dynamically registered client (it registered itself with Kody earlier)',
			`What failed: Kody has no registration for the client_id my app sent${time ? ` (at ${time})` : ''}. My app is reusing a saved registration that Kody no longer has.`,
		)
	}
	lines.push(
		'You are not connected to Kody yet, so do not use Kody MCP tools. Work on my machine instead:',
		'1. Find how my client is configured to reach Kody (for Codex: run `codex mcp list` and note the server name).',
	)
	if (failure.kind === 'metadata_fetch') {
		lines.push(
			'2. Wait a few minutes, then retry the sign-in once (or press Retry on the Kody page).',
			`3. If it still fails and this is the Codex CLI, sign in with dynamic registration instead: \`${codexDcrLoginCommand}\`. That choice applies to that login only.`,
			'4. ChatGPT and the Codex app have no switch for this. Tell me to try again later, and keep the Kody connection as it is.',
			'5. Tell me when to open the new authorize link and approve it.',
		)
	} else {
		lines.push(
			"2. Clear the client's saved login for Kody and sign in again so it registers a new client. Codex: `codex mcp logout <server>` then `codex mcp login <server>`. Other clients: remove the Kody server and any cached OAuth client info for it (for example mcp-remote keeps it in ~/.mcp-auth), then add " +
				mcpUrl +
				' again.',
			'3. Tell me when to open the new authorize link and approve it.',
		)
	}
	lines.push(
		'If it still fails, have me email support@kody.codes with the time it happened and the client name. Never ask me to paste credentials (tokens, refresh tokens, client secrets, or passwords) into chat.',
	)
	return lines.map((line) => redactErrorAgentPromptText(line)).join('\n')
}
