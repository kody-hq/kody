import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { expect, test } from 'vitest'
import { stateMachines } from '../../../tools/state-machines.ts'
import { agentRegistrationState } from './agent-registration/agent-registration-state.ts'
import { deviceAuthorizationState } from './oauth-device/device-authorization-state.ts'
import { inviteState } from './orgs/invite-state.ts'

test('token-mint failure can roll a consumed registration back to claimed', () => {
	expect(agentRegistrationState.can('consumed', 'claimed')).toBe(true)
	expect(agentRegistrationState.can('denied', 'claimed')).toBe(false)
	expect(deviceAuthorizationState.can('pending', 'consumed')).toBe(false)
	expect(deviceAuthorizationState.can('approved', 'consumed')).toBe(true)
	expect(deviceAuthorizationState.isTerminal('consumed')).toBe(true)
	for (const closed of ['accepted', 'revoked', 'expired'] as const) {
		expect(inviteState.can('pending', closed)).toBe(true)
		expect(inviteState.isTerminal(closed)).toBe(true)
	}
	expect(inviteState.can('accepted', 'pending')).toBe(false)
})

test('every production defineStateMachine call is registered for documentation', () => {
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
						ts.isIdentifier(node.expression) &&
						node.expression.text === 'defineStateMachine'
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
		'Register each defineStateMachine call with its machine and file in its package state-machines.ts registry, include that registry in tools/state-machines.ts, then run npm run state-machines:generate.',
	).toEqual(
		stateMachines
			.map((entry) =>
				'definitionFile' in entry ? entry.definitionFile : entry.file,
			)
			.sort(),
	)
})
