import { jsx } from 'react/jsx-runtime'
import { renderStartPage as renderToString } from '../../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { AccountPageHeader } from '../../pages/account-management-components.tsx'
import {
	EntityExplainer,
	resolveEntityExplainer,
} from '../../pages/entity-explainer.tsx'
import { routes } from '#universal/routes.ts'
import { docHref } from '#universal/docs-nav.ts'

test('entity explainers resolve on entity pages, render collapsed, and skip settings-only routes', async () => {
	expect(resolveEntityExplainer('email')?.id).toBe('email')
	expect(resolveEntityExplainer('community')?.id).toBe('community')
	expect(resolveEntityExplainer(undefined)).toBeNull()

	const comparisonHref = docHref('packages-integrations-mcp')
	const integrationsCopy = resolveEntityExplainer('integrations')
	expect(integrationsCopy?.id).toBe('integrations')

	const mcpCopy = resolveEntityExplainer('mcp-servers')
	expect(mcpCopy?.id).toBe('mcp-servers')

	const explainerHtml = await renderToString(
		jsx(EntityExplainer, { copy: integrationsCopy! }),
	)
	expect(explainerHtml).toContain('data-entity-explainer="integrations"')
	expect(explainerHtml).toContain(
		'data-entity-explainer-trigger="integrations"',
	)
	expect(explainerHtml).toContain('data-icon="information"')
	expect(explainerHtml).toContain(
		'popoverTarget="entity-explainer-integrations"',
	)
	expect(explainerHtml).toContain(`href="${comparisonHref}"`)
	const triggerAt = explainerHtml.indexOf('data-entity-explainer-trigger')
	const panelAt = explainerHtml.indexOf('data-entity-explainer="integrations"')
	expect(triggerAt).toBeGreaterThan(-1)
	expect(panelAt).toBeGreaterThan(triggerAt)

	const integrationsHtml = await renderToString(
		jsx(EntityExplainer, { copy: integrationsCopy! }),
	)
	expect(integrationsHtml).toContain(`href="${comparisonHref}"`)
	const mcpHtml = await renderToString(jsx(EntityExplainer, { copy: mcpCopy! }))
	expect(mcpHtml).toContain(`href="${comparisonHref}"`)

	const overviewHtml = await renderToString(
		jsx(AccountPageHeader, {
			title: 'Overview',
			description: 'Account home',
			currentHref: routes.account.href(),
		}),
	)
	expect(overviewHtml).not.toContain('data-entity-explainer')
})

test('detail headers keep their explicit section identity regardless of URL shape', async () => {
	const html = await renderToString(
		jsx(AccountPageHeader, {
			title: 'Connection',
			description: '',
			currentHref: '/@team/-/integrations/apps/google',
			entity: 'integrations',
		}),
	)
	expect(html).toContain('data-entity-explainer="integrations"')
	expect(html).toContain('What is an integration?')
})
