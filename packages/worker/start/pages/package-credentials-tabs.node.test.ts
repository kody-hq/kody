import { createElement } from 'react'
import { expect, test, vi } from 'vitest'
import {
	type PackageCredentialNeedView,
	type PackageCredentialsView,
} from '#universal/credential-contracts.ts'
import { renderStartPage } from '../test-support/render-start-page.ts'
import { usePackageMappingEditor } from './package-credentials-editor.tsx'
import {
	renderCredentialsTab,
	renderMappingsTab,
} from './package-credentials-tabs.tsx'

const editorMocks = vi.hoisted(() => ({ mutateAsync: vi.fn() }))

vi.mock('../credential-mutation.ts', () => ({
	useCredentialMutation: () => ({ mutateAsync: editorMocks.mutateAsync }),
}))

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

test('grandfathered publisher personal defaults offer only a clear action when mapped', async () => {
	const mappedNeed = {
		...need('publisher-calendar', 'publisher'),
		defaults: {
			org: null,
			mine: {
				credentials: [
					{
						id: 'credential-a',
						name: 'calendar-default',
						kind: 'oauth' as const,
						scope: 'personal' as const,
					},
				],
				unusableIds: [],
				updatedAt: '2026-01-01T00:00:00.000Z',
				updatedBy: null,
			},
		},
	}
	const emptyNeed = need('publisher-empty', 'publisher')
	const view: PackageCredentialsView = {
		ok: true,
		package: { id: 'package-a', kodyId: 'repo', canManage: false },
		needs: [mappedNeed, emptyNeed],
		triggers: [],
		locked: [],
		incomplete: [],
	}
	function MappingEditor() {
		const editor = usePackageMappingEditor('team', {
			readPage: () => ({ username: 'team', kodyId: 'repo', orgSlug: 'team' }),
			onSaved: () => {},
		})
		return renderMappingsTab({
			orgSlug: 'team',
			username: 'team',
			kodyId: 'repo',
			view,
			renderMappingCell: editor.renderCell,
		})
	}
	const html = await renderStartPage(createElement(MappingEditor))

	expect(html).toContain(
		'aria-label="Clear your default for publisher-calendar"',
	)
	expect(html).not.toContain(
		'aria-label="Change your default for publisher-calendar"',
	)
	expect(html).not.toContain(
		'aria-label="Clear your default for publisher-empty"',
	)
})
