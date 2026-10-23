import { expect, test } from 'vitest'
import {
	countConnectedAgentEcosystems,
	hasSecondConnectedMcpClient,
} from './onboarding-agent-ecosystems.ts'

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
