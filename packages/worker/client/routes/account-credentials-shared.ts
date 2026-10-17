import { buildAccountSecretPath } from '@kody-internal/shared/account-secret-route.ts'
import { createListDetailLinks } from '#client/list-detail-route.ts'

import { type CredentialListItem } from '#universal/credential-contracts.ts'
import { type AccountCredentialsResponse } from '#universal/credentials-list.ts'
import { orgResourcePath } from '#universal/org-pages.ts'

export const credentialsRoute = createListDetailLinks('/account/credentials')

/**
 * The page that edits `credential` today. Personal credentials granted to a
 * team org are managed in the viewer's personal org.
 */
export function credentialManageHref(
	credential: CredentialListItem,
	page: Pick<AccountCredentialsResponse, 'orgSlug' | 'personalOrgSlug'>,
) {
	const slug =
		credential.scope === 'personal' && page.personalOrgSlug
			? page.personalOrgSlug
			: page.orgSlug
	switch (credential.kind) {
		case 'secret':
		case 'url':
		case 'login':
		case 'signing':
			return orgResourcePath(
				slug,
				'secrets',
				buildAccountSecretPath(
					credential.packageId
						? {
								name: credential.name,
								scope: 'package',
								packageId: credential.packageId,
							}
						: { name: credential.name, scope: 'user' },
				).replace(/^\/account\/secrets\/?/, ''),
			)
		case 'oauth':
			return orgResourcePath(
				slug,
				'integrations',
				encodeURIComponent(credential.name),
			)
		case 'mcp':
			return orgResourcePath(
				slug,
				'mcp-servers',
				encodeURIComponent(credential.id),
			)
		default: {
			const exhaustive: never = credential.kind
			return exhaustive
		}
	}
}
