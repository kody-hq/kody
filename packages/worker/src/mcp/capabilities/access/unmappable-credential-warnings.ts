import { McpCallerError } from '#mcp/caller-error.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import {
	computeEffectivePermissions,
	packageResource,
	checkPermission,
} from '#worker/authorization/authorize.ts'
import {
	isUnmappableCredentialLockedPermission,
	loadOnePackageUnmappableCredentials,
	unmappableCredentialOwnerNotice,
	unmappableCredentialShareWarning,
} from '#worker/credentials/package-unmappable-credentials.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'

export const allowUnmappableCredentialChangesDescription =
	"Owners only. true lets this person or team push, publish, and change the package even while it has unmappable credentials (publisher-supplied or shared with app visitors), so they could make its code use those credentials. false (the default) keeps changes owner-only while the package has them; running it is unaffected. Omit to keep the grant's current choice. Not available for everyone-in-org or profile grants."

/** `Package "name"` for warnings; falls back to the id. */
export async function packageWarningLabel(
	db: D1Database,
	orgId: string,
	packageId: string,
) {
	const saved = await getSavedPackageById(db, { userId: orgId, packageId })
	return `Package "${saved?.name ?? packageId}"`
}

/**
 * The share-time warning for a grant that can change or publish a package
 * with unmappable credentials; empty otherwise. Names credentials only.
 */
export async function unmappableCredentialGrantWarnings(input: {
	env: Env
	orgId: string
	resourceType: string
	resourceId: string | null
	permissions: ReadonlyArray<string>
	changesAllowed: boolean
	packageLabel?: string
	request?: object | null
}): Promise<Array<string>> {
	if (input.resourceType !== 'package' || !input.resourceId) return []
	if (!input.permissions.some(isUnmappableCredentialLockedPermission)) {
		return []
	}
	const credentials = await loadOnePackageUnmappableCredentials({
		env: input.env,
		orgId: input.orgId,
		packageId: input.resourceId,
		request: input.request,
	})
	if (credentials.length === 0) return []
	return [
		unmappableCredentialShareWarning({
			packageLabel:
				input.packageLabel ??
				(await packageWarningLabel(
					input.env.APP_DB,
					input.orgId,
					input.resourceId,
				)),
			credentials,
			changesAllowed: input.changesAllowed,
		}),
	]
}

/**
 * Turning on "allow changes despite unmappable credentials" is an org Owner
 * choice (a profile counts only when its chain also holds manage access on
 * the package). Turning it off only narrows, so any manager may.
 */
export async function assertCanSetUnmappableCredentialChanges(
	ctx: CapabilityContext,
	input: {
		resourceType: string
		resourceId: string
		subjectType: string
		allow: boolean | undefined
	},
) {
	if (input.allow === undefined) return
	if (input.resourceType !== 'package') {
		throw new McpCallerError(
			'allow_changes_despite_unmappable_credentials applies only to package grants.',
		)
	}
	if (input.subjectType !== 'user' && input.subjectType !== 'team') {
		throw new McpCallerError(
			'allow_changes_despite_unmappable_credentials is per person or team; pick one instead of everyone in the organization.',
		)
	}
	if (!input.allow) return
	const request = requireMcpRequest(ctx.callerContext)
	const access = await computeEffectivePermissions({ env: ctx.env, request })
	const resource = packageResource({
		id: input.resourceId,
		userId: request.org.id,
	})
	if (
		!access.isOwner ||
		!checkPermission(access, 'package:manage_access', resource).allowed
	) {
		throw new McpCallerError(
			'Only an org Owner can allow changes despite unmappable credentials. Ask an Owner of this organization to turn it on for this grant.',
		)
	}
}

/**
 * Collaborators decorated with their unmappable-credential warning, plus the
 * owner notice. Both are null/absent when the package has none.
 */
export async function describeCollaboratorUnmappableCredentials<
	Collaborator extends {
		subjectType: string
		permissions: ReadonlyArray<string>
		allowUnmappableCredentialChanges?: boolean
	},
>(input: {
	env: Env
	orgId: string
	packageId: string
	packageName: string
	collaborators: ReadonlyArray<Collaborator>
	viewerIsOwner: boolean
	request?: object | null
}): Promise<{
	collaborators: Array<
		Collaborator & { unmappableCredentialWarning: string | null }
	>
	unmappableCredentials: {
		credentials: Array<{ needKey: string; credentialName: string | null }>
		notice: string
		canAllowChanges: boolean
	} | null
}> {
	const credentials = await loadOnePackageUnmappableCredentials({
		env: input.env,
		orgId: input.orgId,
		packageId: input.packageId,
		request: input.request,
	})
	const packageLabel = `Package "${input.packageName}"`
	return {
		collaborators: input.collaborators.map((collaborator) => ({
			...collaborator,
			unmappableCredentialWarning:
				credentials.length > 0 &&
				collaborator.subjectType !== 'profile' &&
				collaborator.permissions.some(isUnmappableCredentialLockedPermission)
					? unmappableCredentialShareWarning({
							packageLabel,
							credentials,
							changesAllowed:
								collaborator.allowUnmappableCredentialChanges === true,
						})
					: null,
		})),
		unmappableCredentials:
			credentials.length > 0
				? {
						credentials: credentials.map((credential) => ({
							needKey: credential.needKey,
							credentialName: credential.credentialName,
						})),
						notice: unmappableCredentialOwnerNotice({
							packageLabel,
							credentials,
						}),
						canAllowChanges: input.viewerIsOwner,
					}
				: null,
	}
}
