import { expect, test } from 'vitest'
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
	expect(grokBot?.primaryAction?.label.toLowerCase()).toContain(
		'kody bot template',
	)
	expect(grokBot?.primaryAction?.href).toMatch(/^https:\/\/x\.ai\/bot\//)
	expect(grokBot?.primaryAction?.description).toContain('Kody plugin')
	expect(grokBot?.primaryAction?.description).toContain('Kody CLI')
	expect(grokBot?.primaryAction?.alternativeTitle?.toLowerCase()).toContain(
		'plugin',
	)
	expect(grokBot?.steps[0]?.link?.href).toMatch(
		/^grokbot:\/\/app\/v1\/plugin\/add\?id=/,
	)
	for (const text of [
		grokBot?.pitch,
		grokBot?.primaryAction?.description,
		grokBot?.primaryAction?.alternativeTitle,
	]) {
		expect(text).not.toContain('\u2014')
	}
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
	for (const slug of ['cursor', 'muse', 'pi', 'hermes']) {
		const videoId = findWithAgentByPathname(`/with/${slug}`)?.youtubeVideoId
		expect(videoId).toBeTruthy()
		expect(ids).toContain(videoId)
	}
	expect(
		findWithAgentByPathname('/with/instinct')?.youtubeVideoId,
	).toBeUndefined()
})

test('ChatGPT and Codex add Kody as a custom MCP connection, with no marketplace', () => {
	for (const slug of ['chatgpt', 'codex']) {
		const agent = findWithAgentByPathname(`/with/${slug}`)
		const steps = agent?.steps ?? []
		expect(agent?.primaryAction).toBeUndefined()
		for (const step of steps) {
			expect(step.link?.href ?? '').not.toContain('chatgpt.com/plugins')
			expect(step.link?.href ?? '').not.toContain('plugin_asdk')
			expect(step.text.toLowerCase()).not.toContain('marketplace')
			expect(step.code ?? '').not.toContain('codex plugin')
			expect(step.text).not.toContain('\u2014')
		}
	}
	const chatgptSteps = findWithAgentByPathname('/with/chatgpt')?.steps ?? []
	expect(chatgptSteps[0]?.text.toLowerCase()).toContain('mcp servers')
	expect(
		chatgptSteps.some((step) => /^https:\/\/.+\/mcp$/.test(step.code ?? '')),
	).toBe(true)
	expect(chatgptSteps.map((step) => step.text).join(' ')).toContain(
		'Add custom MCP server',
	)
	expect(findWithAgentByPathname('/with/codex')?.steps[0]?.code).toMatch(
		/^codex mcp add kody --url https:\/\/.+\/mcp$/,
	)
})
