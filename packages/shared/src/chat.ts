import {
	array,
	literal,
	nullable,
	number,
	object,
	optional,
	string,
	type InferOutput,
	union,
} from 'remix/data-schema'
import { type OwnerId, type PersonId } from './owner-person-ids.ts'
import { type OrgRole, type RequestContext } from './request-context.ts'

export const mcpUserContextSchema = object({
	userId: string(),
	email: string(),
	username: optional(string()),
	displayName: string(),
	/** Personal org id from `users.personal_org_id` when loaded from APP_DB. */
	personalOrgId: optional(string()),
	roles: optional(array(string())),
	permissions: optional(array(string())),
})

export const mcpStorageContextSchema = object({
	sessionId: optional(nullable(string())),
	appId: optional(nullable(string())),
	packageId: optional(nullable(string())),
	storageId: optional(nullable(string())),
})

export const mcpRepoContextSchema = object({
	sourceId: optional(nullable(string())),
	repoId: optional(nullable(string())),
	sessionId: optional(nullable(string())),
	baseCommit: optional(nullable(string())),
	manifestPath: optional(nullable(string())),
	sourceRoot: optional(nullable(string())),
	publishedCommit: optional(nullable(string())),
	entityKind: optional(nullable(string())),
	entityId: optional(nullable(string())),
})

export const mcpExecutionOriginSchema = union([
	literal('interactive'),
	literal('background'),
])

export const mcpOrgBindingSchema = object({
	org: object({
		id: string(),
		slug: nullable(string()),
	}),
	/** Null for grant-only outside collaborators. */
	role: nullable(
		union([literal('owner'), literal('member'), literal('billing')]),
	),
})

export const mcpCallerContextSchema = object({
	baseUrl: string(),
	executionOrigin: optional(mcpExecutionOriginSchema),
	user: optional(nullable(mcpUserContextSchema)),
	storageContext: optional(nullable(mcpStorageContextSchema)),
	repoContext: optional(nullable(mcpRepoContextSchema)),
	/**
	 * Profile (ADR 0092) the credential is bound to. Absent / null is the live
	 * mirror: the person's own access.
	 */
	profileId: optional(nullable(string())),
	/** That profile's chain (ids, root first), frozen for run attribution. */
	profileChain: optional(nullable(array(string()))),
	/**
	 * OAuth client the bearer grant was issued to (MCP host or `kody login`
	 * CLI). Becomes the request credential id so usage can be attributed to
	 * the connection. Absent for sessions, API tokens, and Automation.
	 */
	oauthClientId: optional(nullable(string())),
	/**
	 * DB-backed org membership the request acts in. Absent / null derives the
	 * person's personal org from `user`.
	 */
	orgBinding: optional(nullable(mcpOrgBindingSchema)),
	/**
	 * How many resource change events led to this package run (1 for a run
	 * started by a change a person made). Changes the run makes carry it on,
	 * so event chains stop at the cap. Absent outside resource event runs.
	 */
	resourceEventDepth: optional(nullable(number())),
})

type McpUserContextInferred = InferOutput<typeof mcpUserContextSchema>

export type McpUserContext = Omit<
	McpUserContextInferred,
	'userId' | 'roles' | 'permissions' | 'username' | 'personalOrgId'
> & {
	/**
	 * The signed-in person, or the org's owning account for Automation runs.
	 * Read `McpCallerContext.request` for the org and the actor.
	 */
	userId: PersonId
	/** Personal org owner id when loaded from `users.personal_org_id`. */
	personalOrgId?: OwnerId
	username?: string
	roles?: Array<string>
	permissions?: Array<string>
}
export type McpStorageContext = InferOutput<typeof mcpStorageContextSchema>
export type McpRepoContext = InferOutput<typeof mcpRepoContextSchema>
export type McpExecutionOrigin = InferOutput<typeof mcpExecutionOriginSchema>
export type McpOrgBinding = {
	org: { id: OwnerId; slug: string | null }
	role: OrgRole | null
}
type McpCallerContextInferred = InferOutput<typeof mcpCallerContextSchema>

/**
 * The serializable caller context: what crosses worker boundaries and what
 * jobs persist in `caller_context_json`. Carries no derived identity.
 */
export type McpCallerContextWire = Omit<
	McpCallerContextInferred,
	| 'user'
	| 'profileId'
	| 'profileChain'
	| 'oauthClientId'
	| 'orgBinding'
	| 'resourceEventDepth'
> & {
	user?: McpUserContext | null
	profileId?: string | null
	profileChain?: ReadonlyArray<string> | null
	oauthClientId?: string | null
	orgBinding?: McpOrgBinding | null
	resourceEventDepth?: number | null
}

/**
 * A caller context with its resolved request context: the org whose data the
 * call reads and writes, the acting person (if any), attribution, and the
 * credential. `createMcpCallerContext` and `parseMcpCallerContext` derive it
 * from `user` (plus the optional wire `orgBinding`) and the request source;
 * `request` itself is never serialized or read from serialized input. Null
 * only when there is no signed-in user.
 */
export type McpCallerContext = McpCallerContextWire & {
	request: RequestContext | null
}
