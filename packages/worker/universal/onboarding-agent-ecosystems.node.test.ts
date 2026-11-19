import { expect, test } from 'vitest'
import {
	countConnectedAgentEcosystems,
	hasSecondConnectedMcpClient,
	onboardingSameEcosystemNote,
} from './onboarding-agent-ecosystems.ts'
import {
	onboardingSecondAgentConnectedStatusLabel,
	onboardingSecondAgentLede,
} from './onboarding-process.ts'

test('a second agent is a second ecosystem, not a second Cursor login', () => {
	type Kinds = Parameters<typeof countConnectedAgentEcosystems>[0]
	const kinds = (...list: Array<Kinds[number]['kind']>): Kinds =>
		list.map((kind) => ({ kind }))
	const ecosystems: Array<[Kinds, number]> = [
		[kinds('cursor'), 1],
		[kinds('cursor', 'cursor-local', 'cursor-cloud', 'grok-bot'), 1],
		[kinds('cursor-cloud', 'grok-bot', 'grok', 'grok-cli'), 1],
		[kinds('codex', 'chatgpt', 'claude-desktop'), 2],
	]
	expect(
		ecosystems.filter(
			([connected, want]) => countConnectedAgentEcosystems(connected) !== want,
		),
	).toEqual([])
	const second: Array<[Kinds, boolean]> = [
		[kinds('cursor-local', 'cursor-cloud'), false],
		[kinds('cursor-local', 'grok'), false],
		[kinds('cursor', null, 'other'), false],
		[kinds(null, null), false],
		[kinds('cursor-cloud', 'claude-code'), true],
	]
	expect(
		second.filter(
			([connected, want]) => hasSecondConnectedMcpClient(connected) !== want,
		),
	).toEqual([])
})

test('Step 3 explains that a second Claude app does not count as a second ecosystem', () => {
	expect(
		onboardingSameEcosystemNote('claude-desktop', [
			{ kind: 'claude-code', label: 'Claude Code' },
		]),
	).toBe(
		'Claude Code is already connected, and it is in the same Claude ecosystem, so this one will not count as your second agent. Pick an agent from another ecosystem to finish Step 3.',
	)
	expect(
		countConnectedAgentEcosystems([
			{ kind: 'claude-code' },
			{ kind: 'claude-desktop' },
		]),
	).toBe(1)
	expect(
		onboardingSameEcosystemNote('devin', [
			{ kind: 'claude-code', label: 'Claude Code' },
		]),
	).toBeNull()
	expect(
		onboardingSameEcosystemNote('claude-code', [
			{ kind: 'claude-code', label: 'Claude Code' },
		]),
	).toBeNull()
	expect(onboardingSecondAgentLede).toContain(
		'Two Claude apps, like Claude Code and Claude Desktop, count as one.',
	)
	expect(
		[
			{ active: true, status: 'active' },
			{ active: false, status: 'invoice_credit' },
			{ active: false, status: 'already_paid' },
		].map((gift) =>
			onboardingSecondAgentConnectedStatusLabel(
				gift as Parameters<typeof onboardingSecondAgentConnectedStatusLabel>[0],
			),
		),
	).toEqual([
		"You've connected a second agent. Pro is free for 2 weeks.",
		"You've connected a second agent. You get 2 weeks of your plan as an invoice credit.",
		"You've connected a second agent.",
	])
})
