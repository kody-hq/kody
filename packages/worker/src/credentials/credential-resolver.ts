/**
 * The contract every credential kind implements behind `resolveCredential`.
 *
 * A resolver's `resolve` step reads metadata only and returns a handle. The
 * door then calls the handle's `authorize` and, only when that returns,
 * `apply`, which is the one step that reads credential material. The door
 * writes the audit row for every outcome from the resolver's audit subject.
 */
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import {
	AuthorizationError,
	authorize,
} from '#worker/authorization/authorize.ts'
import { type IntegrationTokenRefreshResult } from '#worker/integrations/token-refresh.ts'
import { type ResolvedProviderSecret } from '#mcp/secrets/secret-providers/types.ts'
import { type ResolvedSecret } from '#mcp/secrets/service.ts'
import { type SecretScope } from '#mcp/secrets/types.ts'
import { type StorageContext } from '#mcp/storage.ts'
import { type CredentialAuditSubject } from './credential-resolution-audit.ts'
import {
	credentialResource,
	missingCredentialResource,
} from './credential-ids.ts'
import { type CredentialFillSite } from './fill-placement.ts'
import { type PackageStamp } from './package-stamp.ts'
import { type ResolvedLoginSession } from './login-resolver.ts'
import {
	type SigningOperation,
	type SigningResult,
} from './signing-resolver.ts'
import { type ResolvedCredentialUrl } from './url-resolver.ts'

/** Where a scoped client places a value on one request. */
export type ClientPlacement =
	| { kind: 'header'; name: string; value: string }
	| { kind: 'query'; param: string; value: string }

/**
 * Where the fetch gateway filled or refused a placeholder. The audit row
 * stores the lowercase header name, or `url` / `body`. A header named `url`
 * or `body` is stored as `header:url` or `header:body`, so
 * `placement IN ('url', 'body')` counts only non-header placements.
 */
export type CredentialFetchPlacement =
	| { kind: 'header'; name: string }
	| { kind: 'url' }
	| { kind: 'body' }

const reservedFetchPlacementLabels = new Set(['url', 'body'])

/** Audit value for one fetch placement. Header names are lowercased. */
export function credentialFetchPlacementKey(
	placement: CredentialFetchPlacement,
): string {
	switch (placement.kind) {
		case 'header': {
			const name = placement.name.trim().toLowerCase()
			if (!name) {
				throw new Error('A header credential placement needs a header name.')
			}
			// A header literally named url or body must not count as that place.
			if (reservedFetchPlacementLabels.has(name)) return `header:${name}`
			return name
		}
		case 'url':
			return 'url'
		case 'body':
			return 'body'
		default: {
			const exhaustive: never = placement
			throw new Error(`Unhandled credential placement: ${String(exhaustive)}`)
		}
	}
}

export type ResolvedClientPlacement = {
	placement: ClientPlacement
	/** Texts that carry the value, for echo redaction of the response. */
	substitutedValues: ReadonlyArray<string>
	/** The inject shape with no value, for a 401 / 403 hint. */
	shape: string
}

/**
 * Normalized host the value is about to be sent to. When set, the door
 * enforces the credential's host allowlist, so an unapproved host is an
 * audited denial instead of a successful resolution the caller then rejects.
 * Only pass a host that placeholder expansion cannot change.
 */
type RequestHost = string | null

/** What is being resolved. `use` picks the package rules that apply. */
export type CredentialTarget =
	/** `{{secret:…}}` / `secret-basic` placeholders and `secretJwtSign`. */
	| {
			use: 'secret'
			name: string
			scope?: SecretScope | null
			storageContext: StorageContext
			/** Org slug for approval links in denial messages. */
			orgSlug?: string | null
			requestHost?: RequestHost
			/**
			 * Fetch-gateway placements of this placeholder. Each one is its own
			 * `credential.resolve` row. Other callers omit it.
			 */
			placements?: ReadonlyArray<CredentialFetchPlacement>
			/**
			 * Precise fill sites for placement observe/enforce (path vs query
			 * split). Audit `placements` may still use combined `url`.
			 */
			fillSites?: ReadonlyArray<CredentialFillSite>
	  }
	/** `packageSecrets.get` / `.has`: a declared `kody.secretMounts` alias. */
	| {
			use: 'package-secret-mount'
			alias: string
			callerContext: McpCallerContext
			/**
			 * `.has` uses `presence`: find the row and run package-access
			 * without decrypting. `.get` keeps the default `value` path.
			 */
			access?: 'presence' | 'value'
	  }
	/**
	 * Webhook `verification.secretName`, challenge `secretName`, and the apply
	 * `destination.secretName`. Read in the stamped package's buckets.
	 */
	| { use: 'webhook-secret'; name: string }
	/** `{{secret/provider:ref}}` vault references. */
	| {
			use: 'provider-secret'
			provider: string
			ref: string
			storageContext: StorageContext
			requestHost?: RequestHost
			/**
			 * Fetch-gateway placements of this placeholder. Each one is its own
			 * `credential.resolve` row. Other callers omit it.
			 */
			placements?: ReadonlyArray<CredentialFetchPlacement>
			/** Precise fill sites for placement observe/enforce. */
			fillSites?: ReadonlyArray<CredentialFillSite>
	  }
	/** `{{integration-token:…}}` and webhook apply integration auth. */
	| {
			use: 'integration-token'
			name: string
			packageKodyId?: string | null
			requestHost?: RequestHost
			/**
			 * Fetch-gateway placements of this placeholder. Each one is its own
			 * `credential.resolve` row. Other callers omit it.
			 */
			placements?: ReadonlyArray<CredentialFetchPlacement>
			/** Precise fill sites for placement observe/enforce. */
			fillSites?: ReadonlyArray<CredentialFillSite>
	  }
	/** `integrationTokenRefresh` and webhook apply 401 retry. */
	| {
			use: 'integration-refresh'
			name: string
			userEmail?: string
			packageKodyId?: string | null
			waitUntil?: (promise: Promise<unknown>) => void
	  }
	/** `kody.mcp.<server>.<tool>`: a tool call on the org's MCP hub. */
	| {
			use: 'mcp-connection'
			serverId: string
			serverName: string
			waitUntil?: (promise: Promise<unknown>) => void
	  }
	/**
	 * A `url` credential picked by id: the relative path and query code sends
	 * to the credential's own URL. Not reachable from package code until the
	 * credential clients ship (T).
	 */
	| { use: 'url'; credentialId: string; path: string }
	/**
	 * A `login` credential picked by id: its session, from the exchange it
	 * runs, placed for the HTTPS request to `requestUrl`, whose host must be
	 * one of the credential's hosts. The caller places it only on that
	 * request. Not reachable from package code until the credential clients
	 * ship (T).
	 */
	| {
			use: 'login'
			credentialId: string
			requestUrl: URL
			/** The session a host just answered 401 to; it is dropped first. */
			rejectedSessionId?: string | null
	  }
	/**
	 * A `signing` credential picked by id: a JWT or HMAC signature made with
	 * its key, for a request to `requestHost`, which must be one of the
	 * credential's hosts. The caller places the signature only on a request
	 * to that host. Not reachable from package code until the credential
	 * clients ship (T).
	 */
	| {
			use: 'signing'
			credentialId: string
			requestHost: string
			operation: SigningOperation
	  }
	/**
	 * A Key (`secret` kind) picked by id through a `credential()` client:
	 * placed by its `inject` for the HTTPS request to `requestUrl`, whose host
	 * must be one of its hosts. Package allowlists do not apply; the actor's
	 * Use is the only grant.
	 */
	| { use: 'client-key'; credentialId: string; requestUrl: URL }
	/**
	 * An OAuth connection picked by id through a `credential()` client: its
	 * access token as a Bearer header for the HTTPS request to `requestUrl`,
	 * on one of the connection's hosts.
	 */
	| { use: 'client-oauth'; credentialId: string; requestUrl: URL }
	/** A `credential()` client's OAuth connection refreshing its tokens. */
	| {
			use: 'client-oauth-refresh'
			credentialId: string
			userEmail?: string
			waitUntil?: (promise: Promise<unknown>) => void
	  }

export type CredentialUse = CredentialTarget['use']

export type ResolvedPackageSecretMount = {
	alias: string
	name: string
	/** Opaque `{{secret:…}}` ref. Plaintext never leaves the host. */
	ref: string
	scope: SecretScope
	packageId: string
	kodyId: string
}

export type McpServerConnection = {
	callTool(input: {
		toolName: string
		args: Record<string, unknown>
		/**
		 * Runs after the hub returns and before the success audit. A throw
		 * is the call's failure: one `mcp.call` failure row, then rethrow.
		 * Callers use it to reject a payload they will not return.
		 */
		accept?: (result: CallToolResult) => void
	}): Promise<CallToolResult>
}

export type ResolvedCredentialByUse = {
	secret: ResolvedSecret
	'package-secret-mount': ResolvedPackageSecretMount
	'webhook-secret': ResolvedSecret
	'provider-secret': ResolvedProviderSecret
	'integration-token': string | null
	'integration-refresh': IntegrationTokenRefreshResult
	'mcp-connection': McpServerConnection
	url: ResolvedCredentialUrl
	login: ResolvedLoginSession
	signing: SigningResult
	'client-key': ResolvedClientPlacement
	'client-oauth': ResolvedClientPlacement
	'client-oauth-refresh': { refreshed: boolean }
}

export type ResolvedCredential<T extends CredentialTarget> =
	ResolvedCredentialByUse[T['use']]

export type ResolveCredentialInput<T extends CredentialTarget> = {
	env: Env
	/** The org that owns the credential. */
	orgId: OwnerId
	/**
	 * The run's request context. Null only on platform paths that have no
	 * run (webhook ingress verification); those need an attested stamp.
	 */
	actor: RequestContext | null
	packageStamp?: PackageStamp | null
	/**
	 * The package the run belongs to when the door is not stamped (the
	 * credential client). Only the self-publish guard reads it; it never binds
	 * package buckets or rules.
	 */
	runPackageId?: string | null
	/**
	 * The run's own package id (null = ad hoc execute) for the nested
	 * personal-secret rule (GHSA-5fv3).
	 */
	runContextPackageId?: string | null
	/** App origin for approval links in denial messages. */
	baseUrl: string
	/**
	 * Extra `credential.resolve` audit details, such as the viewer of an
	 * internet-visible app using its owner's credential. Never a value.
	 */
	auditDetails?: Record<string, string | null>
	credential: T
}

export type CredentialTargetFor<U extends CredentialUse> = Extract<
	CredentialTarget,
	{ use: U }
>

export type ResolverCall<C extends CredentialTarget = CredentialTarget> = {
	input: ResolveCredentialInput<CredentialTarget>
	credential: C
	/** Audit subject the door writes; resolvers fill in the credential id. */
	subject: CredentialAuditSubject
}

/** Metadata for one resolution. It never holds a credential value. */
export type CredentialHandle<Result> = {
	/** The actor's Use on the credential id, then package and host rules. */
	authorize(): Promise<void>
	/** The only step that reads credential material. */
	apply(): Promise<Result>
}

export type CredentialResolver<U extends CredentialUse> = {
	auditSubject(credential: CredentialTargetFor<U>): CredentialAuditSubject
	/** Finds the credential by metadata; never reads a value. */
	resolve(
		call: ResolverCall<CredentialTargetFor<U>>,
	): Promise<CredentialHandle<ResolvedCredentialByUse[U]>>
	/** Whether a result audits as success rather than not found. */
	isFound(result: ResolvedCredentialByUse[U]): boolean
}

export function permissionForUse(use: CredentialUse): OrgPermission {
	switch (use) {
		case 'secret':
		case 'package-secret-mount':
		case 'webhook-secret':
		case 'provider-secret':
		case 'url':
		case 'login':
		case 'signing':
		case 'client-key':
			return 'secret:use'
		case 'integration-token':
		case 'integration-refresh':
		case 'mcp-connection':
		case 'client-oauth':
		case 'client-oauth-refresh':
			return 'integration:use'
		default: {
			const exhaustive: never = use
			throw new Error(`Unhandled credential use: ${String(exhaustive)}`)
		}
	}
}

/**
 * Every run needs its person's Use on the concrete credential, by its stable
 * id, saved package or not: package rules (allowed packages, integration
 * usage mode) only narrow it further. A trigger resolves an org credential
 * only while its enabler has Use on it. A credential that was not found is
 * checked against a target no grant names, so a non-holder sees a denial
 * rather than learning whether the name exists.
 */
export async function authorizeActorUse(
	call: ResolverCall,
	credentialId: string | null,
	label: string = call.subject.name,
) {
	const { input, subject } = call
	subject.credentialId = credentialId
	// Webhook ingress verifies a signature before any run exists; the secret
	// never reaches package code.
	if (!input.actor && call.credential.use === 'webhook-secret') return
	await authorize(
		{ env: input.env, request: input.actor },
		permissionForUse(call.credential.use),
		credentialId
			? credentialResource(input.orgId, { id: credentialId, name: label })
			: missingCredentialResource(input.orgId, label),
	)
}

/**
 * Personal-credential Use does not go through `authorize`, so scoped tokens
 * still need an explicit family check (same rule as `listUsableCredentials`).
 */
export function assertCredentialScopeAllows(
	call: ResolverCall,
	permission: OrgPermission,
) {
	assertActorScopeAllowsCredential(
		{
			actor: call.input.actor,
			orgId: call.input.orgId,
			credentialId: call.subject.credentialId,
			name: call.subject.name,
		},
		permission,
	)
}

/** `assertCredentialScopeAllows` for callers outside a resolver call. */
export function assertActorScopeAllowsCredential(
	input: {
		actor: RequestContext | null | undefined
		orgId: OwnerId
		credentialId: string | null
		name: string
	},
	permission: OrgPermission,
) {
	const scopes = input.actor?.credential.scopes ?? null
	if (scopes === null || scopes.includes(permission)) return
	const mintScopes = [...new Set([...scopes, permission])].sort()
	throw new AuthorizationError({
		code: 'credential_scope',
		permission,
		orgId: input.orgId,
		resource: input.credentialId
			? credentialResource(input.orgId, {
					id: input.credentialId,
					name: input.name,
				})
			: missingCredentialResource(input.orgId, input.name),
		message: `This credential is not scoped for ${permission}. Mint a token that adds it: from Kody MCP, call cliCredentialBootstrap({ lifetime: "short", scopes: [${mintScopes.map((scope) => JSON.stringify(scope)).join(', ')}] }) and run the returned cli_command; or after \`kody login\`, run \`npx @kodycodes/cli auth bootstrap --lifetime short --scopes ${mintScopes.join(',')}\`. Use those scopes with tokenCreate only for CI/headless.`,
		mintScopes,
	})
}
