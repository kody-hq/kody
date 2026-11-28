import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import type {
	RuntimePackageAppIdentity,
	RuntimePackageAppVisitSession,
	RuntimePackageAppVisitor,
} from '@kody-internal/shared/runtime-worker.ts'
import { resolvePackageAppOwnerByStableUserId } from '#app/package-app-owner.ts'
import type { ParsedPackageAppSession } from '#app/package-app-session.ts'
import {
	packageAppSessionCredentialIsLive,
	visitSessionRequestFor,
} from '#app/package-viewer-access.ts'
import { authorizeAppVisit } from '#worker/app-visit/authorize.ts'
import type { AppVisitSessionCredential } from '#worker/app-visit/session-credential.ts'
import type { PackageAppServeOwner } from '#worker/package-runtime/package-app-serve.ts'

/**
 * The one access decision for a signed-in package-app visit session, shared
 * by every HTTP request on a package-app host and by realtime sockets opened
 * from those requests while they stay open.
 */

export type AuthorizedPackageAppServe =
	| {
			kind: 'ok'
			owner: PackageAppServeOwner
			visitor: RuntimePackageAppVisitor
			/** The live app the slug names; null when the visit named none. */
			appId: string | null
			/** Whether serve will ask this outside visitor for "Run as me" first. */
			needsRunConsent: boolean
			/** Org `access_epoch` the decision was made at. */
			epoch: number
			visitorEmail: string
			sessionIssuedAt: number
			/** True for a visit session an agent opened with `appOpenLink`. */
			agent: boolean
	  }
	| { kind: 'session-required' }
	| {
			kind: 'forbidden'
			visitorEmail: string
			/** The live session person, for an identity-only internet-visible serve. */
			person: RuntimePackageAppIdentity
	  }

/**
 * Confirm the session person is still live, then authorize the visit with
 * {@link authorizeAppVisit}, the check `appFetch` also uses. A person's own
 * browser session carries no profile and no token scopes; a session an agent
 * opened with `appOpenLink` carries its credential's, so it is authorized
 * exactly like that token's `appFetch`. The visitor keeps their live org
 * role; the owner is the org, not the visitor's personal account.
 */
export async function authorizePackageAppVisitorForOrg(input: {
	env: Env
	stableUserId: string
	issuedAt: number
	handle: string
	/** Package slug so app:execute is checked on that app, not any grant. */
	kodyId?: string
	/** The agent credential the visit session carries, when it has one. */
	credential?: AppVisitSessionCredential | null
}): Promise<AuthorizedPackageAppServe> {
	const person = await resolvePackageAppOwnerByStableUserId({
		env: input.env,
		stableUserId: input.stableUserId,
		issuedAt: input.issuedAt,
	})
	if (!person) return { kind: 'session-required' }
	const credential = input.credential ?? null
	if (
		credential &&
		!(await packageAppSessionCredentialIsLive({
			env: input.env,
			stableUserId: input.stableUserId,
			credential,
		}))
	) {
		return { kind: 'session-required' }
	}

	const viewer = {
		userId: personIdFromStored(input.stableUserId),
		username: person.username,
	}
	const visit = await authorizeAppVisit({
		env: input.env,
		callerRequest: visitSessionRequestFor(viewer, credential),
		ownerHandle: input.handle,
		appSlug: input.kodyId,
	})
	if (visit.kind === 'not-found') return { kind: 'session-required' }
	if (visit.kind === 'forbidden') {
		return {
			kind: 'forbidden',
			visitorEmail: person.email,
			person: { userId: viewer.userId, username: person.username },
		}
	}

	// Team org entitlements resolve by org id alone. Pairing the visitor's
	// email with the team org id would miss the users row and fall to Free.
	const ownerEmail =
		visit.owner.userId === person.personalOrgId ? person.email : ''
	return {
		kind: 'ok',
		owner: {
			userId: visit.owner.userId,
			username: visit.owner.username,
			email: ownerEmail,
			displayName: visit.owner.displayName,
		},
		visitor: visit.visitor,
		appId: visit.app?.id ?? null,
		needsRunConsent: visit.needsRunConsent,
		epoch: visit.epoch,
		visitorEmail: person.email,
		sessionIssuedAt: input.issuedAt,
		agent: credential !== null,
	}
}

/** What a realtime socket opened from this session needs to be re-authorized. */
export function packageAppVisitSessionFor(input: {
	parsed: ParsedPackageAppSession
	handle: string
	kodyId: string
}): RuntimePackageAppVisitSession {
	const { parsed } = input
	return {
		stableUserId: parsed.session.stableUserId,
		issuedAt: parsed.issuedAt,
		expiresAt: parsed.expiresAt,
		handle: input.handle,
		kodyId: input.kodyId,
		credential: parsed.session.credential ?? null,
	}
}

export type PackageAppVisitSessionStatus = 'live' | 'expired' | 'revoked'

/**
 * Whether `session` may still use the app, decided exactly as the next HTTP
 * request carrying it would be: refused once its cookie expires, once the
 * person is gone, suspended or changed their password, once its API token
 * is revoked, once its `app:execute` access (grants, role, profile chain)
 * or an outside visitor's "Run as me" approval is removed, or once its slug
 * names a different app.
 */
export async function checkPackageAppVisitSession(input: {
	env: Env
	session: RuntimePackageAppVisitSession
	/** Saved package the socket runs; the session's slug must still name it. */
	appId: string
	now?: number
}): Promise<PackageAppVisitSessionStatus> {
	const { session } = input
	if (session.expiresAt <= (input.now ?? Date.now())) return 'expired'
	const authorized = await authorizePackageAppVisitorForOrg({
		env: input.env,
		stableUserId: session.stableUserId,
		issuedAt: session.issuedAt,
		handle: session.handle,
		kodyId: session.kodyId,
		credential: session.credential ?? null,
	})
	// Serve also refuses an outside visitor whose "Run as me" approval is gone.
	return authorized.kind === 'ok' &&
		authorized.appId === input.appId &&
		!authorized.needsRunConsent
		? 'live'
		: 'revoked'
}
