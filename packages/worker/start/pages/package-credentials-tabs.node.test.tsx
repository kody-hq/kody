import { expect, test } from 'vitest'
import {
	type PackageCredentialNeedView,
	type PackageCredentialsView,
} from '#universal/credential-contracts.ts'
import { renderStartPage } from '../test-support/render-start-page.ts'
import { renderCredentialsTab } from './package-credentials-tabs.tsx'

function need(
	key: string,
	supplier: 'publisher' | 'executor',
	required?: boolean,
): PackageCredentialNeedView {
	return {
		key,
		kind: 'oauth',
		provider: key,
		description: `${key} credentials`,
		multiple: false,
		supplier,
		...(supplier === 'executor' ? { required } : {}),
		defaults: { org: null, mine: null },
		effective: {
			source: 'none',
			status: 'unbound',
			credentials: [],
			candidates: [],
			createUrl: null,
		},
		options: [],
		createUrl: '/credentials/new',
	}
}

test('credential needs show publisher and executor supplier labels', async () => {
	const view: PackageCredentialsView = {
		ok: true,
		package: { id: 'package-a', kodyId: 'repo', canManage: false },
		needs: [
			need('publisher-calendar', 'publisher'),
			need('required-calendar', 'executor', true),
			need('optional-calendar', 'executor', false),
		],
		triggers: [],
		locked: [],
		incomplete: [],
	}
	const html = await renderStartPage(
		renderCredentialsTab({
			orgSlug: 'team',
			username: 'team',
			kodyId: 'repo',
			view,
		}),
	)

	expect(html).toContain('Set by the publisher')
	expect(html).toContain('Publisher credentials: Not set')
	expect(html).toContain('Required')
	expect(html).toContain('Optional')
})
