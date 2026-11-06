import type { AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { loadCredentialDetail } from '#worker/credentials/credential-detail.ts'
import { listLocalReadSettings } from '#worker/credentials/local-read-store.ts'
import { loadCredentialLocalReadsView } from '#app/credential-local-reads.ts'
import { listCredentialsForViewer } from '#worker/credentials/credential-list.ts'
import { listCredentialProviderBindings } from '#worker/credentials/credential-provider-bindings.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { listSavedPackagesByUserId } from '#worker/package-registry/repo.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import type { CredentialListFilters } from '#universal/credential-contracts.ts'
import {
	type AccountCredentialsResponse,
	filterCredentialList,
} from '#universal/credentials-list.ts'

/** The Credentials list for the org this request is bound to. */
export async function loadAccountCredentialsData(input: {
	env: Env
	user: AuthenticatedAppUser
	filters?: CredentialListFilters
	/** A credential id to load the detail pane for. */
	selectedId?: string | null
}): Promise<AccountCredentialsResponse> {
	const orgId = ownerIdFromCaller({
		request: input.user.request,
		user: input.user.mcpUser,
	})
	const viewer = input.user.mcpUser.userId
	const personalId = personalOrgIdForPerson(input.user.mcpUser)
	const teamOrg = orgId !== personalId
	const orgSlug = input.user.request.org.slug ?? input.user.username
	const [personalOrgSlug, listed, providers, packages] = await Promise.all([
		teamOrg
			? loadOrgBindingForOrg(input.env.APP_DB, viewer, personalId).then(
					(binding) => binding?.org.slug ?? null,
				)
			: orgSlug,
		listCredentialsForViewer({ env: input.env, request: input.user.request }),
		listCredentialProviderBindings(input.env.APP_DB, orgId),
		listSavedPackagesByUserId(input.env.APP_DB, { userId: orgId }),
	])
	// `selected` does not depend on the filters.
	const selectedItem = input.selectedId
		? listed.find((item) => item.id === input.selectedId)
		: undefined
	const selected = selectedItem
		? await loadCredentialDetail({
				env: input.env,
				request: input.user.request,
				orgId,
				ownedByViewer: !teamOrg || selectedItem.scope === 'personal',
				credential: selectedItem,
				packages,
			})
		: null
	const selectedProvider = selectedItem
		? undefined
		: providers.find((binding) => binding.id === input.selectedId)
	const selectedLocalReads =
		selectedItem &&
		selectedItem.kind === 'secret' &&
		selectedItem.packageId === null
			? await loadCredentialLocalReadsView({
					env: input.env,
					request: input.user.request,
					credentialId: selectedItem.id,
					...(teamOrg && selectedItem.scope === 'personal'
						? { personalOrgSlug }
						: {}),
				})
			: selectedProvider
				? await loadCredentialLocalReadsView({
						env: input.env,
						request: input.user.request,
						credentialId: selectedProvider.id,
					})
				: null
	const settings = await listLocalReadSettings(input.env.APP_DB, [
		...listed
			.filter((item) => item.kind === 'secret' && item.packageId === null)
			.map((item) => item.id),
		...providers.map((binding) => binding.id),
	])
	const localReadBadges: AccountCredentialsResponse['localReadBadges'] = {}
	for (const [credentialId, setting] of settings) {
		if (setting.enabled) {
			localReadBadges[credentialId] = { lastReadAt: setting.lastReadAt }
		}
	}
	return {
		ok: true,
		selected,
		selectedLocalReads,
		localReadBadges,
		credentials: input.filters
			? filterCredentialList(listed, input.filters)
			: listed,
		orgSlug,
		personalOrgSlug,
		teamOrg,
		providers,
		packages: packages.map((row) => ({
			id: row.id,
			kodyId: row.kodyId,
			name: row.name,
		})),
	}
}
