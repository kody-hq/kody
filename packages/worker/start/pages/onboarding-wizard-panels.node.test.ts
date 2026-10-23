import { renderStartPage as renderToString } from '../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import {
	defaultKodyMcpUrl,
	grokBotInstallUrl,
	kodyBotTemplateLabel,
	kodyBotTemplateUrl,
} from '../../client/routes/onboarding-mcp-clients.ts'
import { renderConnectAgentPanel } from './onboarding-wizard-panels.tsx'

type ConnectProps = Parameters<typeof renderConnectAgentPanel>[0]

const connectPanel = (props: Partial<ConnectProps>) =>
	renderToString(
		renderConnectAgentPanel({
			entrance: () => {},
			onSelectStep() {},
			agentChooser: null,
			mcpServerUrl: defaultKodyMcpUrl,
			mcpHighlights: {},
			activeStep: 1,
			loggedIn: false,
			hasMcpClient: false,
			selectedAgent: null,
			selectedAgentLabel: null,
			...props,
		}),
	)

const missing = (html: string | undefined, parts: Array<string>) =>
	parts.filter((part) => !html?.includes(part))

test('Grok Bot leads with the Kody Bot template and keeps the plugin as the manual path', async () => {
	const grokBot = await connectPanel({
		selectedAgent: 'grok-bot',
		selectedAgentLabel: 'Grok Bot',
		loggedIn: true,
	})
	expect(
		missing(grokBot, [
			`href="${kodyBotTemplateUrl}"`,
			kodyBotTemplateLabel,
			'data-testid="onboarding-kody-bot-template-summary"',
			'data-testid="onboarding-mcp-manual-json"',
			'Or add the Kody plugin to a Grok Bot you already use',
			`href="${grokBotInstallUrl}"`,
			'Add the Kody plugin to Grok Bot',
		]),
	).toEqual([])
	const html = grokBot ?? ''
	const templateAt = html.indexOf(`href="${kodyBotTemplateUrl}"`)
	const manualAt = html.indexOf('data-testid="onboarding-mcp-manual-json"')
	const pluginAt = html.indexOf(`href="${grokBotInstallUrl}"`)
	expect(templateAt).toBeGreaterThan(-1)
	expect(templateAt).toBeLessThan(manualAt)
	expect(manualAt).toBeLessThan(pluginAt)
	// The plugin path sits inside the collapsed disclosure, not above it.
	expect(
		html.slice(manualAt).startsWith('data-testid="onboarding-mcp-manual-json"'),
	).toBe(true)
	expect(html.slice(manualAt, pluginAt)).not.toContain(' open=""')
})
