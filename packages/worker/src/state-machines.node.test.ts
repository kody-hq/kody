import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { expect, test } from 'vitest'
import { stateMachines } from '../../../tools/state-machines.ts'
import { stateMachines as workerStateMachines } from './state-machines.ts'

test('pins migrated lifecycle graphs including token-mint rollback', () => {
	expect(
		workerStateMachines.slice(0, 3).map(({ machine }) => machine.transitions),
	).toEqual([
		{
			pending: ['approved', 'denied'],
			approved: ['consumed'],
			denied: [],
			consumed: [],
		},
		{
			pending: ['claimed', 'denied'],
			claimed: ['consumed'],
			denied: [],
			consumed: ['claimed'],
		},
		{
			pending: ['accepted', 'revoked', 'expired'],
			accepted: [],
			revoked: [],
			expired: [],
		},
	])
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
