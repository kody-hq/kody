import { expect, test } from 'vitest'
import { type CredentialListItem } from '#universal/credential-contracts.ts'
import { credentialManageHref } from './account-credentials-shared.ts'

function credential(
	overrides: Partial<CredentialListItem> & { id: string; name: string },
): CredentialListItem {
	return {
		kind: 'secret',
		scope: 'org',
		provider: null,
		description: '',
		hosts: [],
		inject: null,
		placement: null,
		packageId: null,
		lockedToPackageIds: [],
		expiresAt: null,
		createdAt: '2026-10-11T00:00:00.000Z',
		updatedAt: '2026-10-11T00:00:00.000Z',
		status: 'ok',
		statusMessage: null,
		mcp: null,
		...overrides,
	}
}

test('rows open the page that edits each kind, in the org that owns it', () => {
	const page = { orgSlug: 'acme', personalOrgSlug: 'ann' }
	expect(
		credentialManageHref(credential({ id: 'a', name: 'DEPLOY_KEY' }), page),
	).toBe('/@acme/-/secrets/user/DEPLOY_KEY')
	expect(
		credentialManageHref(
			credential({ id: 'b', name: 'SLACK', packageId: 'pkg-1' }),
			page,
		),
	).toBe('/@acme/-/secrets/package/pkg-1/SLACK')
	expect(
		credentialManageHref(
			credential({ id: 'c', name: 'work github', kind: 'oauth' }),
			page,
		),
	).toBe('/@acme/-/integrations/work%20github')
	expect(
		credentialManageHref(
			credential({ id: 'mcp-1', name: 'docs', kind: 'mcp' }),
			page,
		),
	).toBe('/@acme/-/mcp-servers/mcp-1')
	// A personal credential granted to the team org is managed at home.
	expect(
		credentialManageHref(
			credential({ id: 'd', name: 'mine', scope: 'personal' }),
			page,
		),
	).toBe('/@ann/-/secrets/user/mine')
})
