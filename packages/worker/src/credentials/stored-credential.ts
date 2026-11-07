/**
 * Finding and authorizing a stored credential by id for the later kinds
 * (`url`, `login`, `signing`). A pick is an org credential of the run org, or
 * the actor's own personal credential granted to it. Lookup reads metadata
 * only; the handle's caller reads the value after `authorizeStoredCredential`.
 */
import {
	findStoredCredentialForUse,
	type StoredCredential,
} from '#mcp/secrets/service.ts'
import type { StoredCredentialKind } from '#mcp/secrets/types.ts'
import { loadPersonalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import {
	CredentialNotFoundError,
	CredentialRequestRefusedError,
} from './credential-request.ts'
import {
	authorizeActorPersonalUse,
	authorizeActorUse,
	permissionForUse,
	type ResolverCall,
} from './credential-resolver.ts'

export type StoredCredentialLookup = {
	owner: 'org' | 'personal'
	found: StoredCredential
	readValue: () => Promise<string>
} | null

export async function findStoredCredential(
	call: ResolverCall,
	credentialId: string,
): Promise<StoredCredentialLookup> {
	const { input } = call
	const org = await findStoredCredentialForUse({
		env: input.env,
		ownerId: input.orgId,
		credentialId,
	})
	if (org) return { owner: 'org', ...org }
	const person = input.actor?.actor?.userId
	if (!person) return null
	const personal = await findStoredCredentialForUse({
		env: input.env,
		ownerId: await loadPersonalOrgIdForPerson(input.env.APP_DB, person),
		credentialId,
	})
	return personal ? { owner: 'personal', ...personal } : null
}

/**
 * The actor's Use on the pick, then that it is the kind the need asked for
 * and has hosts. A personal credential passes only for its owner, through a
 * live grant to the run org. A missing pick is checked like any credential
 * that was not found, so a non-holder sees a denial.
 */
export async function authorizeStoredCredential(
	call: ResolverCall,
	credentialId: string,
	lookup: StoredCredentialLookup,
	kind: StoredCredentialKind,
): Promise<StoredCredential> {
	if (!lookup) {
		await authorizeActorUse(call, null, credentialId)
		throw new CredentialNotFoundError()
	}
	const { found } = lookup
	call.subject.name = found.name
	switch (lookup.owner) {
		case 'org':
			await authorizeActorUse(call, found.credentialId, found.name)
			break
		case 'personal':
			call.subject.credentialId = found.credentialId
			await authorizeActorPersonalUse({
				env: call.input.env,
				actor: call.input.actor,
				orgId: call.input.orgId,
				credentialId: found.credentialId,
				name: found.name,
				permission: permissionForUse(call.credential.use),
			})
			break
		default: {
			const exhaustive: never = lookup.owner
			throw new Error(`Unhandled credential owner: ${String(exhaustive)}`)
		}
	}
	if (found.kind !== kind) throw new CredentialNotFoundError()
	if (found.allowedHosts.length === 0) {
		throw new CredentialRequestRefusedError(
			'host_not_allowed',
			'This credential has no hosts, so it is not sent anywhere.',
		)
	}
	return found
}
