import { parseSafe } from 'remix/data-schema'
import { type OrgPermission } from '@kody-internal/shared/org-permissions.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	mcpCallerContextSchema,
	type McpCallerContext,
	type McpCallerContextWire,
	type McpExecutionOrigin,
	type McpOrgBinding,
	type McpRepoContext,
	type McpStorageContext,
	type McpUserContext,
} from '@kody-internal/shared/chat.ts'
import {
	deriveRequestContext,
	type RequestOrgBinding,
	type RequestSource,
} from '#worker/request-context/request-context.ts'

/** Legacy agent props persist in Durable Object storage, so they stay wire-shaped. */
export type McpServerProps = McpCallerContextWire

type McpCallerContextWireInput = {
	baseUrl: string
	executionOrigin?: McpExecutionOrigin
	user?: McpUserContext | null
	storageContext?: McpStorageContext | null
	repoContext?: McpRepoContext | null
	connectionProfileName?: string | null
	oauthClientId?: string | null
	/**
	 * DB-backed org membership when available. Persisted on the wire so
	 * background re-derivation keeps the org. Omitted derives the personal org
	 * from the user.
	 */
	orgBinding?:
		| RequestOrgBinding
		| McpOrgBinding
		| {
				org: { id: string; slug: string | null }
				role: RequestOrgBinding['role']
		  }
		| null
	/** Resource change event chain depth for a package run (see chat.ts). */
	resourceEventDepth?: number | null
}

function normalizeWireOrgBinding(
	binding: McpCallerContextWireInput['orgBinding'],
): McpOrgBinding | null {
	if (!binding) return null
	return {
		org: {
			id: ownerIdFromStored(binding.org.id as string),
			slug: binding.org.slug,
		},
		role: binding.role,
	}
}

/** The persisted form only (job `caller_context_json`); no request context. */
export function createMcpCallerContextWire(
	input: McpCallerContextWireInput,
): McpCallerContextWire {
	return {
		baseUrl: input.baseUrl,
		executionOrigin: input.executionOrigin,
		user: input.user ?? null,
		storageContext: input.storageContext ?? null,
		repoContext: input.repoContext ?? null,
		connectionProfileName: input.connectionProfileName ?? null,
		...(input.oauthClientId?.trim()
			? { oauthClientId: input.oauthClientId.trim() }
			: {}),
		orgBinding: normalizeWireOrgBinding(input.orgBinding),
		...(input.resourceEventDepth && input.resourceEventDepth > 0
			? { resourceEventDepth: input.resourceEventDepth }
			: {}),
	}
}

export function createMcpCallerContext(
	input: McpCallerContextWireInput & {
		/** How this request reached Kody; decides actor, attribution, credential. */
		source: RequestSource
		/** API-token scopes; null/omitted does not narrow the actor. */
		scopes?: ReadonlyArray<OrgPermission> | null
		/** Execution-context runs: credential ids the context's grant allows. */
		contextCredentialIds?: ReadonlyArray<string> | null
	},
): McpCallerContext {
	const wire = createMcpCallerContextWire(input)
	return {
		...wire,
		request: wire.user
			? deriveRequestContext({
					user: wire.user,
					source: input.source,
					profileName: wire.connectionProfileName,
					oauthClientId: wire.oauthClientId ?? null,
					orgBinding: wire.orgBinding ?? undefined,
					scopes: input.scopes ?? null,
					contextCredentialIds: input.contextCredentialIds ?? null,
				})
			: null,
	}
}

/** Validate a serialized caller context without deriving a request context. */
export function parseMcpCallerContextWire(
	value: unknown,
): McpCallerContextWire {
	const result = parseSafe(mcpCallerContextSchema, value)
	if (!result.success) {
		const message = result.issues.map((issue) => issue.message).join(', ')
		throw new Error(`Invalid MCP caller context: ${message}`)
	}
	const { user, orgBinding, ...rest } = result.value
	return createMcpCallerContextWire({
		...rest,
		orgBinding: normalizeWireOrgBinding(orgBinding),
		user: user
			? (() => {
					const { personalOrgId: wirePersonalOrgId, ...userRest } = user
					return {
						...userRest,
						userId: personIdFromStored(user.userId),
						...(wirePersonalOrgId
							? {
									personalOrgId: ownerIdFromStored(wirePersonalOrgId as string),
								}
							: {}),
					}
				})()
			: null,
	})
}

/** Validate a serialized caller context and derive its request context. */
export function parseMcpCallerContext(
	value: unknown,
	source: RequestSource,
): McpCallerContext {
	const wire = parseMcpCallerContextWire(value)
	return createMcpCallerContext({
		...wire,
		orgBinding: wire.orgBinding ?? undefined,
		source,
	})
}

/** The serializable form of a caller context, without derived identities. */
export function toMcpCallerContextWire(
	context: McpCallerContext,
): McpCallerContextWire {
	const { request: _request, ...wire } = context
	return wire
}
