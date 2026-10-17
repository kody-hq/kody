import {
	orgHasPermission,
	type ManagedOrg,
} from '#app/org-management-access.ts'
import { buildUserAvatarUrl } from '#worker/community/public-urls.ts'
import { listOutsideCollaborators } from '#worker/orgs/org-collaborators-list.ts'
import { listOrgGrantsForView } from '#worker/orgs/org-grants-view.ts'
import {
	type OrgCollaboratorView,
	type OrgCollaboratorsLoaderData,
	type OrgGrantView,
} from '#universal/loader-data.ts'

export async function loadOrgCollaboratorsData(input: {
	env: Env
	user: Parameters<typeof orgHasPermission>[1]
	org: ManagedOrg
}): Promise<OrgCollaboratorsLoaderData> {
	const canManage =
		!input.org.personal &&
		(await orgHasPermission(input.env, input.user, 'member:write'))
	const [people, grants] = await Promise.all([
		listOutsideCollaborators(input.env.APP_DB, input.org.id),
		listOrgGrantsForView(input.env.APP_DB, input.org.id),
	])
	const grantsById = new Map(grants.map((grant) => [grant.id, grant]))
	return {
		ok: true,
		org: input.org,
		collaborators: people.map((person): OrgCollaboratorView => {
			const personGrants: Array<OrgGrantView> = []
			for (const grant of person.grants) {
				const view = grantsById.get(grant.id)
				if (view) personGrants.push(view)
			}
			return {
				userId: person.userId,
				username: person.username,
				displayName: person.displayName,
				avatarUrl: person.username
					? buildUserAvatarUrl({
							username: person.username,
							avatarKey: person.avatarKey,
						})
					: null,
				grants: personGrants,
			}
		}),
		canManage,
	}
}
