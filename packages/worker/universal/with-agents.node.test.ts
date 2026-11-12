import { expect, test } from 'vitest'
import {
	grokBotInstallUrl,
	kodyBotTemplateSummary,
} from './onboarding-mcp-clients.ts'
import {
	findWithAgentByPathname,
	withAgentYoutubeVideoIds,
	withAgents,
} from './with-agents.ts'
import { isYoutubeVideoId } from './youtube-watch.ts'

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

test('Instinct leads with the Kody CLI and keeps MCP to a short note', () => {
	const instinct = findWithAgentByPathname('/with/instinct')
	expect(instinct?.steps.map((step) => step.code)).toEqual([
		'npm install -g @kodycodes/cli',
		'kody login --device',
		'kody search "what can you do"',
	])
	expect(instinct?.steps.some((step) => step.prompt)).toBe(false)
	expect(instinct?.note).toContain('Kody CLI')
	expect(instinct?.note).toContain('https://kody.codes/mcp')
	for (const text of [
		instinct?.note,
		instinct?.pitch,
		...(instinct?.steps.map((step) => step.text) ?? []),
	]) {
		expect(text).not.toContain('\u2014')
	}
})

test('promo videos map to their /with pages and other agents have none', () => {
	const ids = withAgentYoutubeVideoIds()
	expect(ids.length).toBeGreaterThan(0)
	expect(ids.length).toBeLessThan(withAgents.length)
	expect(new Set(ids).size).toBe(ids.length)
	for (const id of ids) {
		expect(isYoutubeVideoId(id)).toBe(true)
	}
	const cursorVideoId = findWithAgentByPathname('/with/cursor')?.youtubeVideoId
	expect(cursorVideoId).toBeTruthy()
	expect(ids).toContain(cursorVideoId)
	expect(findWithAgentByPathname('/with/muse')?.youtubeVideoId).toBe(
		'znnJ4jfGGcg',
	)
	expect(findWithAgentByPathname('/with/pi')?.youtubeVideoId).toBe(
		'czWITu_qvJo',
	)
	expect(findWithAgentByPathname('/with/hermes')?.youtubeVideoId).toBe(
		'ZfAfxwIMOgI',
	)
	expect(
		findWithAgentByPathname('/with/instinct')?.youtubeVideoId,
	).toBeUndefined()
})

test('ChatGPT and Codex sideload the Kody plugin instead of the frozen directory listing', () => {
	for (const slug of ['chatgpt', 'codex']) {
		const agent = findWithAgentByPathname(`/with/${slug}`)
		expect(agent?.steps[0]?.link?.href).toBe('https://chatgpt.com/plugins')
		expect(agent?.steps[0]?.text).toContain('Add custom MCP server')
		expect(agent?.steps.map((step) => step.code)).toContain(
			'https://kody.codes/mcp',
		)
		for (const step of agent?.steps ?? []) {
			expect(step.link?.href ?? '').not.toContain('plugin_asdk_app')
			expect(step.text).not.toContain('plugin directory')
			expect(step.text).not.toContain('\u2014')
		}
	}
	expect(
		findWithAgentByPathname('/with/codex')?.steps.map((step) => step.code),
	).toContain('codex mcp add kody --url https://kody.codes/mcp')
})
