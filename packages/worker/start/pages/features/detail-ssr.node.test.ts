import { createElement } from 'react'
import { expect, test } from 'vitest'
import { renderStartPage } from '../../test-support/render-start-page.ts'
import { CredentialsFeature } from './credentials.tsx'
import { MemoryFeature } from './memory.tsx'
import { PackagesFeature } from './packages.tsx'
import { TriggersFeature } from './triggers.tsx'
import { AppsFeature } from './apps.tsx'

const pages = [
	['credentials', CredentialsFeature, 'integrations'],
	['memory', MemoryFeature, 'memory'],
	['packages', PackagesFeature, 'packages'],
	['triggers', TriggersFeature, 'triggers'],
	['apps', AppsFeature, 'apps'],
] as const

test.each(pages)(
	'%s renders its complete detail content on the server',
	async (slug, Component, orb) => {
		const html = await renderStartPage(
			createElement(Component),
			`/features/${slug}`,
		)
		expect(html).not.toContain('Loading page')
		expect(html.match(/<h1[ >]/g)).toHaveLength(1)
		expect(html).toContain(`/images/lantern/kody-primitives-orb-${orb}.webp`)
		if (slug === 'credentials') {
			expect(html).toContain('href="/onboarding"')
			expect(html).toContain('Connect your agent')
			expect(html).toContain('id="secret-result"')
			expect(html).toContain('it works with Kody.')
		}
		if (slug === 'packages') {
			expect(html).toContain('id="package-source-fallback"')
			expect(html).toContain('src/brief.ts')
		}
		if (slug === 'memory') {
			expect(html).toContain('id="ms-hero-note"')
			expect(html).toContain('Lead with the decision. Keep updates short.')
		}
	},
)
