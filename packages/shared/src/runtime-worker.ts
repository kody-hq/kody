/**
 * Cross-worker contract between the main `kody` Worker and the package
 * runtime Worker (`packages/runtime-worker`, script `kody-runtime`).
 *
 * The main Worker reaches the runtime Worker over the `RUNTIME_WORKER`
 * service binding. Wholesale HTTP forward covers runtime-owned requests
 * (package-app origin including per-user subdomains, inline package apps,
 * package invocation API). Structured calls:
 * - `GET /__runtime/health` — deploy healthcheck
 * - `RuntimeWorkerService.servePackageApp` — in-process package-app serve for
 *   scripts that lack loopback `PackageAppRuntimeBridge` (slim origin MCP)
 *
 * Durable Object access in either direction (RunLog reads from the main Worker,
 * UserMeter writes from the runtime Worker) uses cross-script Durable Object
 * bindings, not this RPC surface.
 */

import type { OwnerId, PersonId } from './owner-person-ids.ts'
import type { PackageAppMount } from './public-urls.ts'
import type { OrgRole, RequestCredential } from './request-context.ts'

/** Healthcheck endpoint served by the runtime Worker. */
export const runtimeWorkerHealthPath = '/__runtime/health'

export type RuntimeWorkerHealth = {
	status: 'ok'
	commitSha: string | null
	cookieSecretConfigured: boolean
}

export function buildRuntimeWorkerHealth(input: {
	commitSha: string | undefined
	cookieSecretConfigured: boolean
}): RuntimeWorkerHealth {
	const trimmed = input.commitSha?.trim()
	return {
		status: 'ok',
		commitSha: trimmed ? trimmed : null,
		cookieSecretConfigured: input.cookieSecretConfigured,
	}
}

/**
 * Owner already authenticated by the caller (MCP session or package-app
 * session). Runtime must not re-check package-app cookies for this path.
 */
export type RuntimePackageAppServeOwner = {
	userId: OwnerId
	username: string
	email: string
	displayName: string
}

/**
 * The signed-in person using the app. Its requests act as them, with their
 * live role in the owning org (null for an outside collaborator).
 */
export type RuntimePackageAppVisitor = {
	userId: PersonId
	username: string
	role: OrgRole | null
	/**
	 * The agent profile making the visit for the person (`appFetch`). The app
	 * sees the same `userId` with this label added. Absent for the person
	 * themselves.
	 */
	profile?: RuntimePackageAppVisitorProfile | null
	/**
	 * What the visiting credential narrows the person to: its token scopes and
	 * profile chain. Absent for a browser session, which does not narrow.
	 */
	credential?: RuntimePackageAppVisitorCredential | null
}

export type RuntimePackageAppVisitorProfile = { id: string; name: string }

export type RuntimePackageAppVisitorCredential = Pick<
	RequestCredential,
	'scopes' | 'profileId' | 'profileChain' | 'profileOrgId'
>

/**
 * A signed-in person who cannot run the app (no `app:execute` in the owning
 * org) but signed in to it with Kody. Read-only: it names who is visiting so
 * `metaGetCurrentUser` and the visitor header can answer, and grants nothing.
 * The request is still served as an anonymous visitor (no actor, no org
 * binding, anonymous billing and storage).
 */
export type RuntimePackageAppIdentity = {
	userId: PersonId
	username: string
}

/**
 * The agent credential a visit session acts as: what `appOpenLink` copied
 * from the calling token. `profileOrgId` is always set with `profileId`.
 */
export type RuntimePackageAppVisitSessionCredential = Pick<
	RequestCredential,
	'kind' | 'id' | 'scopes'
> & {
	profileId?: string
	profileChain?: ReadonlyArray<string>
	profileOrgId?: OwnerId
}

/**
 * The package-app session a signed-in visitor rides on: what a long-lived
 * realtime socket needs to be authorized again the way the next HTTP request
 * from the same session would be, and when that session's cookie expires.
 * It names a credential by id and never carries a secret.
 */
export type RuntimePackageAppVisitSession = {
	stableUserId: string
	issuedAt: number
	/** Epoch ms the session cookie expires; no request is served after it. */
	expiresAt: number
	/** Org handle and app slug the session was authorized for. */
	handle: string
	kodyId: string
	/** Set for an agent's visit opened with `appOpenLink`. */
	credential?: RuntimePackageAppVisitSessionCredential | null
}

export type RuntimePackageAppPath = {
	username: string
	kodyId: string
	restPath: string
	/** `custom-hostname` serves the bound app at `/` on a customer host. */
	mount: PackageAppMount
}

export type RuntimePackageAppServeInput = {
	request: Request
	owner: RuntimePackageAppServeOwner
	/**
	 * Null for an anonymous visitor of an internet-visible app. Bridge calls
	 * that need an actor then fail closed.
	 */
	visitor: RuntimePackageAppVisitor | null
	/**
	 * With a null visitor: the signed-in person behind an otherwise anonymous
	 * request, when they signed in to this app with Kody. Identity only.
	 */
	identity?: RuntimePackageAppIdentity | null
	/**
	 * With a null visitor and no identity: the signed-in person who has not
	 * signed in to this app yet. Used only to send them to consent for optional
	 * executor needs; package code never receives it.
	 */
	consentPrincipal?: RuntimePackageAppIdentity | null
	/**
	 * With a null visitor: the published commit the owner approved for
	 * internet-visible serving (ADR 0069). Serve refuses an anonymous request
	 * when it is missing or the live published commit differs.
	 */
	approvedPublishedCommit?: string | null
	/**
	 * With a visitor: the session they were authorized from. Required for a
	 * realtime upgrade, so the socket can be authorized again while it is open.
	 */
	visitSession?: RuntimePackageAppVisitSession | null
	packagePath: RuntimePackageAppPath
	/**
	 * An agent visit (`appFetch`, or a session opened with `appOpenLink`), its
	 * explicit smoke-test opt-in, and `appOpenLink`'s consent-only preflight.
	 */
	dispatch?: {
		readonly agent?: true
		readonly synthetic?: boolean
		readonly preflight?: true
	}
}

/**
 * `RUNTIME_WORKER` service binding entrypoint (`RuntimeWorkerService`).
 * `.fetch` keeps wholesale HTTP forward; `servePackageApp` is the only
 * structured serve call for slim-origin in-process callers.
 */
export type RuntimeWorkerServiceContract = {
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
	servePackageApp(input: RuntimePackageAppServeInput): Promise<Response>
}
