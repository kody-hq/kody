import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	identityIconNotFound,
	ownerIdentityIconCacheControl,
	serveIdentityIcon,
} from './identity-icon-response.ts'
import { getEntitySourceByEntity } from '#worker/repo/entity-sources.ts'
import { getUserRepoById } from '#worker/repo/user-repos.ts'
import { identityIconCommitForSource } from '#worker/repo/identity-icon.ts'

export function createAccountRepoIconHandler(env: Env) {
	return async ({
		request,
		params,
	}: {
		request: Request
		params: { iconCommit: string; repoId: string }
	}) => {
		const user = await readAuthenticatedAppUser(request, env)
		if (!user) return identityIconNotFound()

		const repo = await getUserRepoById(env.APP_DB, {
			userId: user.mcpUser.userId,
			repoId: params.repoId,
		})
		if (!repo) return identityIconNotFound()

		const source = await getEntitySourceByEntity(env.APP_DB, {
			userId: repo.userId,
			entityKind: 'repo',
			entityId: repo.id,
		})
		if (!source) return identityIconNotFound()

		const iconCommit = identityIconCommitForSource(source)
		if (!iconCommit || params.iconCommit !== iconCommit) {
			return identityIconNotFound()
		}

		return await serveIdentityIcon({
			env,
			repoId: source.repo_id,
			iconCommit: params.iconCommit,
			ownerUserId: repo.userId,
			leafName: repo.name,
			includePackageAppIcon: false,
			cacheControl: ownerIdentityIconCacheControl,
			isServableCommit: async () => {
				const current = await getEntitySourceByEntity(env.APP_DB, {
					userId: repo.userId,
					entityKind: 'repo',
					entityId: repo.id,
				})
				return (
					current != null &&
					identityIconCommitForSource(current) === params.iconCommit
				)
			},
			logLabel: 'repo-identity-icon',
		})
	}
}
