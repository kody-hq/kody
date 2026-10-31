import { type ProfileItem, type ProfilesPageData } from '#universal/profiles.ts'

function profileFixture(
	id: string,
	parent: ProfileItem | null,
	overrides: Partial<ProfileItem> = {},
): ProfileItem {
	const name = overrides.name ?? id
	return {
		id,
		name,
		parentProfileId: parent?.id ?? null,
		actingUserId: 'u_jane',
		actingHandle: 'jane',
		depth: (parent?.depth ?? 0) + 1,
		status: 'active',
		expiresAt: null,
		effectiveExpiresAt: parent?.effectiveExpiresAt ?? null,
		revokedAt: null,
		createdAt: '2026-10-31T14:00:00.000Z',
		chain: [...(parent?.chain ?? []), { id, name }],
		grants: [],
		...overrides,
	}
}

function profilesTreeFixture(): Array<ProfileItem> {
	const releaseBot = profileFixture('prf_release', null, {
		name: 'release-bot',
		expiresAt: '2026-12-31T00:00:00.000Z',
		effectiveExpiresAt: '2026-12-31T00:00:00.000Z',
		grants: [
			{
				resourceType: 'package',
				resourceId: 'pkg_deploy',
				permissions: ['package:execute', 'package:read'],
				label: 'deploy-tools',
				href: '/@jane/deploy-tools',
			},
			{
				resourceType: 'org',
				resourceId: 'org_jane',
				permissions: ['org:execute'],
				label: '@jane',
				href: null,
			},
		],
	})
	const changelog = profileFixture('prf_changelog', releaseBot, {
		name: 'changelog-writer',
		grants: [
			{
				resourceType: 'package',
				resourceId: 'pkg_deploy',
				permissions: ['package:read'],
				label: 'deploy-tools',
				href: '/@jane/deploy-tools',
			},
		],
	})
	const triage = profileFixture('prf_triage', null, {
		name: 'triage-bot',
		status: 'revoked',
		revokedAt: '2026-10-31T15:00:00.000Z',
	})
	const triageHelper = profileFixture('prf_triage_helper', triage, {
		name: 'label-helper',
		status: 'parent_inactive',
	})
	return [releaseBot, changelog, triage, triageHelper]
}

export function profilesPageFixture(
	overrides: Partial<Extract<ProfilesPageData, { enabled: true }>> = {},
): ProfilesPageData {
	return {
		enabled: true,
		orgSlug: 'jane',
		orgId: 'org_jane',
		personalOrg: true,
		viewer: { userId: 'u_jane', username: 'jane', isOwner: true },
		allMembers: false,
		profiles: profilesTreeFixture(),
		tokens: [
			{
				id: 'tok_release',
				name: 'release-bot ci',
				profileId: 'prf_release',
				status: 'active',
				scopes: ['org:execute'],
				expiresAt: '2026-11-01T14:00:00.000Z',
				maxExpiresAt: '2026-11-01T14:00:00.000Z',
				lastUsedAt: null,
				createdAt: '2026-10-31T14:05:00.000Z',
			},
		],
		grantOptions: [
			{
				resourceType: 'org',
				resourceId: 'org_jane',
				label: '@jane (org-level)',
				permissions: ['org:read', 'org:execute'],
			},
		],
		listError: null,
		...overrides,
	}
}
