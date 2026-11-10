import { orgPermissions } from '@kody-internal/shared/org-permissions.ts'
import {
	mintApiToken,
	type ApiTokenMintParent,
	type ApiTokenOrgBinding,
	type ApiTokenSecretView,
} from './service.ts'

/**
 * Scopes on a CLI credential (`kody login` device token or a redeemed
 * `cliCredentialBootstrap` code). The full org-permission vocabulary so
 * `kody api` can call every Open API operation the caller's role allows.
 * `authorize` still intersects this list with the org role.
 */
export const cliTokenScopes = orgPermissions

/**
 * The one mint behind every CLI credential: `kody login` device tokens and
 * redeemed `cliCredentialBootstrap` codes. Scopes default to
 * {@link cliTokenScopes}; callers pass a narrower list only when someone
 * explicitly asked for one. A `parent` caps scopes and absolute expiry so a
 * child never outranks or outlives it.
 */
export async function mintCliToken(input: {
	db: D1Database
	userId: string
	orgId?: string
	orgBinding: ApiTokenOrgBinding
	name: string
	scopes?: ReadonlyArray<unknown>
	idleTtlSeconds: number
	maxLifetimeSeconds: number
	createdVia: 'cli-login' | 'cli-bootstrap'
	parent?: ApiTokenMintParent
	now?: Date
}): Promise<ApiTokenSecretView> {
	return mintApiToken({
		db: input.db,
		userId: input.userId,
		...(input.orgId ? { orgId: input.orgId } : {}),
		orgBinding: input.orgBinding,
		name: input.name,
		scopes: input.scopes ?? cliTokenScopes,
		idleTtlSeconds: input.idleTtlSeconds,
		maxLifetimeSeconds: input.maxLifetimeSeconds,
		createdVia: input.createdVia,
		...(input.parent ? { parent: input.parent } : {}),
		...(input.now ? { now: input.now } : {}),
	})
}
