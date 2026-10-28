import { expect, test } from 'vitest'
import {
	chainFixture,
	contextFixture,
	pageFixture,
	sharedBuildbox,
} from '../test-support/execution-contexts-fixtures.ts'
import { renderStartPage } from '../test-support/render-start-page.ts'
import { createElement } from 'react'
import { type ExecutionContextsPageData } from '#universal/execution-contexts.ts'
import { ExecutionContextsRoute } from './execution-contexts.tsx'

function route(
	payload: ExecutionContextsPageData,
	selectedId: string | null,
	currentHref: string,
) {
	return createElement(ExecutionContextsRoute, {
		payload,
		selectedId,
		currentHref,
	})
}

const href = '/@jane/-/execution-contexts'

function text(html: string) {
	return html
		.replace(/<!-- -->/g, '')
		.replace(/<style[^>]*>[\s\S]*?<\/style>/g, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&#x27;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, '&')
		.replace(/\s+/g, ' ')
}

test('flag off shows the experiment callout, not a permission error', async () => {
	const html = await renderStartPage(
		route({ enabled: false, orgSlug: 'jane' }, null, href),
		href,
	)
	expect(html).toContain('data-testid="execution-contexts-flag-off"')
	expect(text(html)).toContain('Try execution contexts')
	expect(text(html)).not.toMatch(/permission|denied/i)
})

test('list shows chain, statuses, unutilized note and register card', async () => {
	const html = await renderStartPage(route(pageFixture(), null, href), href)
	const body = text(html)
	expect(body).toContain('Your fallback chain in @jane')
	expect(body).toContain('Kody cloud')
	expect(body).toContain('Not in any chain')
	expect(body).toContain('1st in your chain')
	expect(body).toContain('Shared with you, opt in to use')
	expect(body).toContain('buildbox (needs opt-in)')
	expect(body).toContain('kody context register --name my-machine')
	expect(body).toContain('run `kody login` again first')
	expect(html).toContain('href="/@jane/-/execution-contexts/ec_buildbox"')
})

test('chain rows have up/down buttons and a keyboard grab handle; cloud is not draggable', async () => {
	const html = await renderStartPage(
		route(
			pageFixture({
				chain: chainFixture([
					{ kind: 'context', id: 'ec_server', usable: true },
					{ kind: 'context', id: 'ec_laptop', usable: true },
					{ kind: 'cloud' },
				]),
			}),
			null,
			href,
		),
		href,
	)
	expect(html).toContain('aria-label="Move home-server down"')
	expect(html).toContain('aria-label="Reorder my-laptop, position 2 of 2"')
	expect(html).toMatch(/role="status"/)
	const cloud = html.slice(html.indexOf('data-testid="chain-cloud"'))
	expect(cloud.slice(0, cloud.indexOf('</li>'))).not.toContain('draggable')
})

test('unusable stored entries stay visible with their reason', async () => {
	const html = await renderStartPage(
		route(
			pageFixture({
				chain: chainFixture([
					{
						kind: 'context',
						id: 'ec_buildbox',
						usable: false,
						unusableReason: 'not_opted_in',
					},
					{ kind: 'cloud' },
				]),
			}),
			null,
			href,
		),
		href,
	)
	expect(text(html)).toContain('Not opted in, skipped')
	expect(html).toContain('aria-label="Remove buildbox from your chain"')
})

test('strict chain with nothing usable warns that runs will fail', async () => {
	const html = await renderStartPage(
		route(
			pageFixture({
				chain: { ...chainFixture([]), strict: true },
			}),
			null,
			href,
		),
		href,
	)
	expect(text(html)).toContain('your execute runs will fail')
	expect(text(html)).toContain('Add Kody cloud back')
})

test('detail for a shared context shows opt-in trust copy and own-runs scope', async () => {
	const html = await renderStartPage(
		route(
			pageFixture({ selected: sharedBuildbox }),
			'ec_buildbox',
			`${href}/ec_buildbox`,
		),
		`${href}/ec_buildbox`,
	)
	const body = text(html)
	expect(html).toContain('data-testid="execution-context-detail"')
	expect(body).toContain('Opt into buildbox?')
	expect(body).toContain('@sam can see the code, inputs, logs and results')
	expect(body).toContain('Local network access is on')
	expect(body).toContain('Add it to the end of my fallback chain')
	expect(html).toMatch(/type="checkbox"(?![^>]*checked)/)
	expect(body).toContain('Runs')
	expect(body).toContain('Audit log')
})

test('opt-in checkbox is disabled when the chain is full', async () => {
	const full = chainFixture([
		{ kind: 'context', id: 'ec_a', usable: true },
		{ kind: 'context', id: 'ec_b', usable: false, unusableReason: 'revoked' },
		{ kind: 'context', id: 'ec_c', usable: true },
		{ kind: 'cloud' },
	])
	const html = await renderStartPage(
		route(
			pageFixture({ chain: full, selected: sharedBuildbox }),
			'ec_buildbox',
			`${href}/ec_buildbox`,
		),
		`${href}/ec_buildbox`,
	)
	expect(html).toMatch(/type="checkbox"[^>]*disabled/)
	expect(text(html)).toContain(
		'Your chain is full, so this context will not be added to it.',
	)
})

test('operator detail shows sharing with levels and no invite links note', async () => {
	const mine = contextFixture()
	const html = await renderStartPage(
		route(pageFixture({ selected: mine }), mine.id, `${href}/${mine.id}`),
		`${href}/${mine.id}`,
	)
	const body = text(html)
	expect(html).toContain('data-testid="context-sharing"')
	expect(body).toContain('Only me')
	expect(body).toContain('Everyone in @jane')
	expect(body).toContain('Not in any chain')
	expect(body).not.toContain('Opt into')
})

test('a missing context id shows a not-found message, not a crash', async () => {
	const html = await renderStartPage(
		route(pageFixture(), 'ec_gone', `${href}/ec_gone`),
		`${href}/ec_gone`,
	)
	expect(text(html)).toContain('does not exist or is not visible to you')
})
