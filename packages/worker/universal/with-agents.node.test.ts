import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
	grokBotInstallUrl,
	kodyBotTemplateSummary,
} from './onboarding-mcp-clients.ts'
import {
	findWithAgentByPathname,
	pickWithAgentOrder,
	resolveWithAgentOrder,
	withAgentIconSrc,
	withAgents,
	type WithAgent,
} from './with-agents.ts'

test('every agent with a /with page has an icon, steps, and no em dash in the pitch', () => {
	const slugs = withAgents.map((agent) => agent.slug)
	expect(new Set(slugs).size).toBe(slugs.length)
	for (const agent of withAgents) {
		const icon = fileURLToPath(
			new URL(`../public${withAgentIconSrc(agent)}`, import.meta.url),
		)
		expect(existsSync(icon), icon).toBe(true)
		expect(agent.steps.length).toBeGreaterThan(0)
		expect(agent.pitch).not.toContain('\u2014')
	}
})

test('agents without an official path get the setup prompt and MCP URL', () => {
	const generic: ReadonlyArray<WithAgent> = withAgents.filter(
		(agent) => !agent.official,
	)
	expect(generic.map((agent) => agent.slug).sort()).toEqual(
		[
			'amp',
			'cue',
			'dots',
			'goose',
			'openmuse',
			'pi',
			'wajo',
			'warp',
			'zed',
		].sort(),
	)
	for (const agent of generic) {
		expect(agent.steps.filter((step) => 'prompt' in step)).toHaveLength(1)
		expect(
			agent.steps.some((step) => step.code === 'https://kody.codes/mcp'),
		).toBe(true)
	}
	// OpenMuse needs its harness wired first; a chat prompt cannot add Kody.
	const openMuse = generic.find((agent) => agent.slug === 'openmuse')
	expect(openMuse?.steps[0]?.link?.href).toBe('/docs/openmuse')
	expect(openMuse?.steps.at(-1)).toMatchObject({ prompt: true })
	for (const agent of withAgents.filter((agent) => agent.official)) {
		expect(agent.steps.some((step) => 'prompt' in step)).toBe(false)
	}
	expect(findWithAgentByPathname('/with/hermes')).toMatchObject({
		name: 'Hermes Agent',
		icon: 'hermes',
		official: true,
	})
	expect(findWithAgentByPathname('/with/hermes')?.steps[0]?.code).toBe(
		'hermes mcp add kody --url https://kody.codes/mcp --auth oauth',
	)
})

test('marquee order is a permutation and untrusted loader data is repaired', () => {
	const order = pickWithAgentOrder()
	expect(order).toContain('cursor')
	expect(order).toContain('codex')
	expect(new Set(order).size).toBe(order.length)

	const repaired = resolveWithAgentOrder(['codex', 'nope', 'codex', 'cursor'])
	expect(repaired.slice(0, 2).map((agent) => agent.slug)).toEqual([
		'codex',
		'cursor',
	])
	expect(repaired.map((agent) => agent.slug)).not.toContain('nope')
	expect(
		repaired.map((agent) => agent.slug).filter((slug) => slug === 'codex'),
	).toHaveLength(1)
	expect(resolveWithAgentOrder(undefined).map((agent) => agent.slug)).toContain(
		'cursor',
	)
})

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
