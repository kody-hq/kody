import {
	IllegalStateTransitionError,
	canHandle,
	finalStatesOf,
	type LifecycleStateOf,
} from '@kody-internal/shared/state-machine.ts'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, expectTypeOf, test } from 'vitest'
import { stateMachines, statusEnums } from '../../../tools/state-machines.ts'
import { renderStateMachines } from '../../../tools/generate-state-machines.ts'
import { agentRegistrationState } from './agent-registration/agent-registration-state.ts'
import { deviceAuthorizationState } from './oauth-device/device-authorization-state.ts'
import { inviteState } from './orgs/invite-state.ts'
import ts from 'typescript'
import { extractMachineGraph } from '../../../tools/state-machine-graph.ts'

test('v6 lifecycle values retain the exact state union rather than string', () => {
	expectTypeOf<LifecycleStateOf<typeof inviteState>>().toEqualTypeOf<
		'pending' | 'accepted' | 'revoked' | 'expired'
	>()
})

test('token-mint failure can roll a consumed registration back to claimed', () => {
	expect(canHandle(agentRegistrationState, 'consumed', 'RESTORE')).toBe(true)
	expect(canHandle(agentRegistrationState, 'denied', 'CLAIM')).toBe(false)
	expect(canHandle(deviceAuthorizationState, 'pending', 'CONSUME')).toBe(false)
	expect(canHandle(deviceAuthorizationState, 'approved', 'CONSUME')).toBe(true)
	expect(finalStatesOf(deviceAuthorizationState).includes('consumed')).toBe(
		true,
	)
	for (const closed of ['accepted', 'revoked', 'expired'] as const) {
		expect(
			canHandle(
				inviteState,
				'pending',
				(() => {
					switch (closed) {
						case 'accepted':
							return 'ACCEPT' as const
						case 'revoked':
							return 'REVOKE' as const
						case 'expired':
							return 'EXPIRE' as const
						default:
							throw new IllegalStateTransitionError(inviteState.id, 'pending', {
								type: String(closed),
							})
					}
				})(),
			),
		).toBe(true)
		expect(finalStatesOf(inviteState).includes(closed)).toBe(true)
	}
	expect(canHandle(inviteState, 'accepted', 'CREATE' as never)).toBe(false)
})

test('every production lifecycle or status enum is registered for documentation', () => {
	const root = resolve(import.meta.dirname, '../../..')
	const found: Array<string> = []
	function scan(directory: string) {
		for (const entry of readdirSync(resolve(root, directory), {
			withFileTypes: true,
		})) {
			const path = `${directory}/${entry.name}`
			if (entry.isDirectory()) {
				if (
					![
						'node_modules',
						'dist',
						'.wrangler',
						'.git',
						'.output',
						'.cache',
					].includes(entry.name)
				)
					scan(path)
			} else if (
				/\.[cm]?[jt]sx?$/.test(path) &&
				!/\.(test|spec)\./.test(path)
			) {
				const source = ts.createSourceFile(
					path,
					readFileSync(resolve(root, path), 'utf8'),
					ts.ScriptTarget.Latest,
					true,
				)
				function visit(node: ts.Node) {
					if (
						ts.isCallExpression(node) &&
						((ts.isIdentifier(node.expression) &&
							node.expression.text === 'defineStatusEnum') ||
							(ts.isPropertyAccessExpression(node.expression) &&
								node.expression.name.text === 'createMachine'))
					)
						found.push(path)
					ts.forEachChild(node, visit)
				}
				visit(source)
			}
		}
	}
	scan('packages')
	expect(
		found.sort(),
		'Register each XState machine or defineStatusEnum call with its definition and file in its package state-machines.ts registry, include that registry in tools/state-machines.ts, then run npm run state-machines:generate.',
	).toEqual(
		[...stateMachines, ...statusEnums]
			.map((entry) =>
				'definitionFile' in entry ? entry.definitionFile : entry.file,
			)
			.sort(),
	)
})

test('registry ids are unique and event-driven graphs have valid reachable states', () => {
	const ids = [
		...stateMachines.map(({ machine }) => machine.id),
		...statusEnums.map(({ statusEnum }) => statusEnum.name),
	]
	expect(new Set(ids).size).toBe(ids.length)
	for (const { statusEnum } of statusEnums)
		for (const state of statusEnum.values)
			expect(state).toMatch(/^[a-z][a-z0-9_-]*$/)
	for (const { machine, file } of stateMachines) {
		const graph = extractMachineGraph(machine, file)
		expect(graph.states).toEqual(Object.keys(machine.states))
		expect(graph.finals).toEqual(finalStatesOf(machine))
		const reachable = new Set([graph.initial])
		for (const state of reachable)
			for (const edge of graph.edges.filter((edge) => edge.source === state))
				reachable.add(edge.target)
		expect([...reachable].sort()).toEqual([...graph.states].sort())
		for (const state of graph.states) {
			expect(state).toMatch(/^[a-z][a-z0-9_-]*$/)
			expect(graph.handlers.some((handler) => handler.source === state)).toBe(
				!graph.finals.includes(state),
			)
		}
	}
})

test('every declared lifecycle event is handled by the machine', () => {
	for (const { machine, file } of stateMachines) {
		const graph = extractMachineGraph(machine, file)
		expect(graph.declaredEvents.length).toBeGreaterThan(0)
		expect([...graph.declaredEvents].sort()).toEqual(
			[...new Set(graph.handlers.map((handler) => handler.event))].sort(),
		)
		for (const event of machine.events)
			expect(graph.declaredEvents).toContain(event)
	}
})

test('documentation separates replacement enums from event-driven graphs', () => {
	const rendered = renderStateMachines(stateMachines, statusEnums)
	const [machines, enums] = rendered.split(
		'## Status enums (not state machines)',
	)
	expect(machines).toContain('| CONSUME | pending | consumed | — |')
	expect(machines).toContain('pending --> consumed: CONSUME')
	expect(machines).not.toContain('consumed --> expired')
	expect(machines).not.toContain('mcp_memories.status')
	expect(enums).toContain('mcp_memories.status')
	expect(enums).toContain('Values: active, deleted, archived')
	expect(enums).not.toContain('mermaid')
})
