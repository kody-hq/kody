import { expect, test } from 'vitest'
import {
	type PackageCredentialNeedView,
	type PackageCredentialsView,
} from '#universal/credential-contracts.ts'
import { renderStartPage } from '../test-support/render-start-page.ts'
import { renderCredentialsTab } from './package-credentials-tabs.tsx'

function need(
	key: string,
	supplier?: 'publisher' | 'executor',
	required?: boolean,
): PackageCredentialNeedView {
	return {
		key,
		kind: 'oauth',
		provider: key,
		description: `${key} credentials`,
		multiple: false,
		...(supplier ? { supplier } : {}),
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

function incomplete(needKey: string) {
	return {
		needKey,
		where: { type: 'default' as const },
		status: 'unbound' as const,
	}
}

test('executor needs show per-runner supply without publisher mapping attention', async () => {
	const view: PackageCredentialsView = {
		ok: true,
		package: { id: 'package-a', kodyId: 'repo', canManage: false },
		needs: [
			need('publisher-calendar', 'publisher'),
			need('visitor-calendar', 'executor', true),
			need('optional-calendar', 'executor', false),
		],
		triggers: [],
		locked: [],
		incomplete: [
			incomplete('publisher-calendar'),
			incomplete('visitor-calendar'),
			incomplete('optional-calendar'),
		],
	}
	const html = await renderStartPage(
		renderCredentialsTab({
			orgSlug: 'team',
			username: 'team',
			kodyId: 'repo',
			view,
		}),
	)

	const bannerStart = html.indexOf(
		'data-testid="package-credentials-incomplete"',
	)
	const bannerEnd = html.indexOf('</section>', bannerStart)
	const banner = html.slice(bannerStart, bannerEnd)
	expect(banner).toContain('1 mapping needs attention')
	expect(banner).toContain('publisher-calendar')
	expect(banner).not.toContain('visitor-calendar')
	expect(banner).not.toContain('optional-calendar')
	expect(html).toContain('Set by the publisher')
	expect(html).toContain('Publisher credentials:<!-- --> <!-- -->Not set')
	expect(html).toContain('Required')
	expect(html).toContain('Optional')

	for (const key of ['visitor-calendar', 'optional-calendar']) {
		const row = html.match(
			new RegExp(`<tr[^>]*data-testid="package-need-${key}"[\\s\\S]*?<\\/tr>`),
		)?.[0]
		expect(row).toBeDefined()
		expect(row).toContain('Each person who runs it supplies their own')
		expect(row).toContain('Executor')
		expect(row).not.toContain('No matching credential')
		expect(row).not.toContain('No credential')
	}
})

test('flag-off needs keep missing mapping attention and status', async () => {
	const html = await renderStartPage(
		renderCredentialsTab({
			orgSlug: 'team',
			username: 'team',
			kodyId: 'repo',
			view: {
				ok: true,
				package: { id: 'package-a', kodyId: 'repo', canManage: false },
				needs: [need('legacy-calendar')],
				triggers: [],
				locked: [],
				incomplete: [incomplete('legacy-calendar')],
			},
		}),
	)

	expect(html).toContain('1 mapping needs attention')
	expect(html).toContain('No matching credential')
	expect(html).toContain('No credential')
	expect(html).not.toContain('Each person who runs it supplies their own')
	expect(html).not.toContain('data-credential-supplier="executor"')
})
