import { jsx } from 'react/jsx-runtime'
import { expect, test } from 'vitest'
import { isNotFound, isRedirect } from '@tanstack/react-router'
import { renderStartPage } from './test-support/render-start-page.ts'
import { WithAgentRoute } from './pages/with-agent.tsx'
import { Route as agentRoute } from './routes/with.$agent.tsx'
import { Route as secretsRoute } from './routes/features_.secrets.tsx'
import { Route as integrationsRoute } from './routes/features_.integrations.tsx'
import { findWithAgent } from '#universal/with-agents.ts'
import {
	absolutizeDocumentHead,
	resolveDocumentHead,
} from '#universal/document-head.ts'

test('agent page shows its connect steps and matching canonical metadata', async () => {
	const agent = findWithAgent('claude-code')!
	const html = await renderStartPage(
		jsx(WithAgentRoute, { agent }),
		'/with/claude-code',
	)
	expect(html).toContain('Kody for <em>Claude Code</em>')
	expect(html).toContain(
		'claude mcp add --transport http -s user kody https://kody.codes/mcp',
	)
	expect(html).toContain('href="/features/credentials"')
	expect(html).toContain('href="/with/cursor"')
	expect(html).not.toContain('href="/with/claude-code"')
	// React separates adjacent text nodes with hydration comments, invisible to readers.
	expect(html.replaceAll('<!-- -->', '')).toContain(
		'Rather let Claude Code handle it?',
	)
	expect(html).not.toContain('official Kody setup')
	const head = absolutizeDocumentHead(
		resolveDocumentHead('withAgent', '/with/claude-code'),
		'https://kody.test',
	)
	expect(head.title).toBe('Kody for Claude Code | Kody')
	expect(head.description).toBe(
		'Claude Code writes the package. Kody keeps it, runs it on a trigger, and shares it with the rest of your team.',
	)
	expect(head.canonicalUrl).toBe('https://kody.test/with/claude-code')
})

test('agent route rejects unknown catalog entries before rendering', () => {
	const beforeLoad = agentRoute.options.beforeLoad as unknown as (input: {
		params: { agent: string }
	}) => unknown
	let failure: unknown
	try {
		beforeLoad({ params: { agent: 'not-an-agent' } })
	} catch (error) {
		failure = error
	}
	expect(isNotFound(failure)).toBe(true)
})

test.each([secretsRoute, integrationsRoute])(
	'retired feature route preserves search in its permanent redirect',
	(route) => {
		const beforeLoad = route.options.beforeLoad as unknown as (input: {
			location: { searchStr: string }
		}) => unknown
		let failure: unknown
		try {
			beforeLoad({ location: { searchStr: '?ref=x' } })
		} catch (error) {
			failure = error
		}
		expect(isRedirect(failure)).toBe(true)
		if (!isRedirect(failure)) throw new Error('Expected redirect')
		expect(failure.options.href).toBe('/features/credentials?ref=x')
		expect(failure.status).toBe(301)
	},
)

test('unofficial agent page leads with its setup prompt and MCP URL', async () => {
	const agent = findWithAgent('amp')!
	const html = await renderStartPage(
		jsx(WithAgentRoute, { agent }),
		'/with/amp',
	)
	expect(html).toContain('Kody for <em>Amp</em>')
	expect(html.replaceAll('<!-- -->', '')).toMatch(
		/Amp doesn(&rsquo;|’|&#x27;)t have an official Kody setup/,
	)
	expect(
		html.match(/aria-label="Copy setup prompt, copy setup prompt"/g),
	).toHaveLength(1)
	expect(html).toContain('<code>https://kody.codes/mcp</code>')
	expect(html).not.toContain('Rather let ')
	expect(html).toContain('href="/with/cursor"')
	expect(resolveDocumentHead('withAgent', '/with/amp').title).toBe(
		'Kody for Amp | Kody',
	)
})
