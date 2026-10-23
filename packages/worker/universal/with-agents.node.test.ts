import { expect, test } from 'vitest'
import {
	grokBotInstallUrl,
	kodyBotTemplateSummary,
} from './onboarding-mcp-clients.ts'
import { findWithAgentByPathname, withAgents } from './with-agents.ts'

test('pathname lookup only accepts /with/:agent for catalog agents', () => {
	expect(findWithAgentByPathname('/with/cursor')?.name).toBe('Cursor')
	expect(findWithAgentByPathname('/with/cursor/')?.name).toBe('Cursor')
	expect(findWithAgentByPathname('/with/unknown')).toBeNull()
	expect(findWithAgentByPathname('/with/cursor/extra')).toBeNull()
})

test('Grok Bot leads with the Kody Bot template and keeps the plugin steps as the alternative', () => {
	const grokBot = findWithAgentByPathname('/with/grok-bot')
	expect(grokBot?.primaryAction).toEqual({
		label: 'Use the Kody Bot template',
		href: 'https://x.ai/bot/yTSGElYcIjFW_5IXu2I-e',
		description: kodyBotTemplateSummary,
		alternativeTitle: 'Or add the Kody plugin to a Grok Bot you already use',
	})
	expect(grokBot?.steps[0]?.link?.href).toBe(grokBotInstallUrl)
	for (const text of [
		grokBot?.pitch,
		grokBot?.primaryAction?.description,
		grokBot?.primaryAction?.alternativeTitle,
	]) {
		expect(text).not.toContain('\u2014')
	}
	// Only Grok Bot has a recommended template today.
	expect(
		withAgents
			.filter((agent) => 'primaryAction' in agent)
			.map((agent) => agent.slug),
	).toEqual(['grok-bot'])
})
