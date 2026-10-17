import { createElement } from 'react'
import { expect, test } from 'vitest'
import { renderStartPage } from '../test-support/render-start-page.ts'
import { pickWalkthroughHosts } from '#universal/walkthrough-hosts.ts'
import { HomeRoute } from './home.tsx'

test('homepage renders agent-led connect links and a deterministic accessible marquee', async () => {
	const html = await renderStartPage(
		createElement(HomeRoute, {
			initialHosts: pickWalkthroughHosts(() => 0),
			landingAgentOrder: ['muse', 'codex', 'cursor'],
			landingHeroVideos: [],
		}),
		'/',
	)
	expect(html).toContain('The <em>shared cloud</em> for your team’s agents')
	expect(html).toContain('Connect your agent')
	expect(html).toContain('href="/docs/connect-your-agent"')
	expect(html).toContain('aria-label="Agents that work with Kody"')
	const marquee =
		html.match(/<nav[^>]*class="landing-agents"[\s\S]*?<\/nav>/)?.[0] ?? ''
	const order = [...marquee.matchAll(/href="\/with\/([^"]+)"/g)].map(
		(match) => match[1],
	)
	expect(order.slice(0, 3)).toEqual(['muse', 'codex', 'cursor'])
	expect(order.filter((slug) => slug === 'muse')).toHaveLength(3)
	expect(marquee.match(/tabindex="-1"/g)?.length).toBeGreaterThan(0)
	expect(html).toContain('href="/with/cursor"')
	expect(html).toContain('href="/with/claude-code"')
	expect(html).toContain('href="/with/amp"')

	expect(html).toContain('class="landing-pcard"')
	expect(html).toContain('href="/believe"')
	expect(html).toContain('Invisible <em>software</em>')
	expect(html).toContain('What Kody <em>is</em> and <em>is not</em>')
})
