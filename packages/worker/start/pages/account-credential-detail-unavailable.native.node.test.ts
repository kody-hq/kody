import { expect, test } from 'vitest'
import type { CredentialListItem } from '#universal/credential-contracts.ts'
import type { AccountCredentialDetail } from '#universal/credentials-list.ts'
import { renderStartPage } from '../test-support/render-start-page.ts'
import { renderCredentialDetail } from './account-credential-detail.tsx'
import { renderVaultCredentialDetail } from './account-credential-vault-detail.tsx'

const credential: CredentialListItem = {
	id: 'cred-1',
	name: 'annToken',
	kind: 'secret',
	scope: 'personal',
	provider: null,
	description: '',
	hosts: [],
	inject: null,
	placement: null,
	placementOrigin: null,
	packageId: null,
	lockedToPackageIds: [],
	expiresAt: null,
	createdAt: '2026-10-11T00:00:00.000Z',
	updatedAt: '2026-10-11T00:00:00.000Z',
	status: 'ok',
	statusMessage: null,
	mcp: null,
}

function detail(
	overrides: Partial<AccountCredentialDetail> = {},
): AccountCredentialDetail {
	return {
		id: credential.id,
		placeholder: null,
		grants: [],
		grantsUnavailable: false,
		usage: [],
		usageTruncated: false,
		usageUnreadable: 0,
		hostSettings: null,
		fillPlacementObservation: null,
		...overrides,
	}
}

function render(input: {
	detail: AccountCredentialDetail
	credential?: CredentialListItem
	localReadsUnavailableFor?: string | null
	rawSigningUnavailableFor?: string | null
}) {
	return renderStartPage(
		renderCredentialDetail({
			credential: input.credential ?? credential,
			detail: input.detail,
			manageHref: '/@ann/-/secrets',
			teamOrg: false,
			packagesById: new Map(),
			orgSlug: 'ann',
			localReads: null,
			localReadsUnavailableFor: input.localReadsUnavailableFor ?? null,
			rawSigning: null,
			rawSigningUnavailableFor: input.rawSigningUnavailableFor ?? null,
		}),
	)
}

test('shared with says unavailable instead of "not granted" when grants failed', async () => {
	const failed = await render({ detail: detail({ grantsUnavailable: true }) })
	expect(failed).toContain('data-testid="shared-with-unavailable"')
	expect(failed).not.toContain('Not granted to any team org.')

	const empty = await render({ detail: detail() })
	expect(empty).toContain('Not granted to any team org.')
	expect(empty).not.toContain('shared-with-unavailable')
})

test('local reads show unavailable only for the credential whose load failed', async () => {
	const failed = await render({
		detail: detail(),
		localReadsUnavailableFor: credential.id,
	})
	expect(failed).toContain('data-testid="local-reads-unavailable"')

	const unsupported = await render({ detail: detail() })
	expect(unsupported).not.toContain('Local reads')

	const stale = await render({
		detail: detail(),
		localReadsUnavailableFor: 'another-credential',
	})
	expect(stale).not.toContain('local-reads-unavailable')
})

test('raw signing shows unavailable when its load failed', async () => {
	const signing = { ...credential, kind: 'signing' as const }
	const failed = await render({
		credential: signing,
		detail: detail(),
		rawSigningUnavailableFor: signing.id,
	})
	expect(failed).toContain('data-testid="raw-signing-unavailable"')

	const unsupported = await render({ credential: signing, detail: detail() })
	expect(unsupported).not.toContain('Raw signing')
})

test('vault detail shows local reads unavailable when its load failed', async () => {
	const html = await renderStartPage(
		renderVaultCredentialDetail({
			binding: {
				id: 'vault-1',
				providerId: 'onepassword',
				provider: '1Password',
				packageId: 'pkg-1',
				doorSecretName: 'OP_TOKEN',
				placement: null,
				updatedAt: '2026-10-11T00:00:00.000Z',
			},
			packageName: 'vault-door',
			orgSlug: 'ann',
			localReads: null,
			localReadsUnavailableFor: 'vault-1',
		}),
	)
	expect(html).toContain('data-testid="local-reads-unavailable"')
})
