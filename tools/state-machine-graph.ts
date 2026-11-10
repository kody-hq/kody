import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import type { LifecycleMachine } from '../packages/shared/src/state-machine.ts'

export type LifecycleGraph = {
	initial: string
	states: string[]
	finals: string[]
	declaredEvents: string[]
	handlers: Array<{ source: string; event: string }>
	edges: Array<{ source: string; event: string; target: string; guard: string }>
}

export function extractMachineGraph(machine: LifecycleMachine, file: string) {
	return extractMachineGraphSource(
		machine.id,
		readFileSync(resolve(file), 'utf8'),
		file,
	)
}

export function extractMachineGraphSource(
	id: string,
	source: string,
	file = 'machine.ts',
): LifecycleGraph {
	const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
	function fail(node: ts.Node, message: string): never {
		const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1
		throw new Error(`${file}:${line}: ${id}: ${message}`)
	}
	function unwrap(node: ts.Expression): ts.Expression {
		return ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node
	}
	function object(node: ts.Expression): Map<string, ts.Expression> {
		node = unwrap(node)
		if (!ts.isObjectLiteralExpression(node))
			fail(node, 'Expected a literal object')
		const entries = new Map<string, ts.Expression>()
		for (const property of node.properties) {
			if (
				!ts.isPropertyAssignment(property) ||
				ts.isComputedPropertyName(property.name)
			)
				fail(
					property,
					'Spreads, methods, shorthand and computed properties cannot establish graph completeness',
				)
			const name =
				ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
					? property.name.text
					: fail(property, 'Expected a literal property name')
			if (entries.has(name)) fail(property, `Duplicate property ${name}`)
			entries.set(name, property.initializer)
		}
		return entries
	}
	function literal(node: ts.Expression): string {
		node = unwrap(node)
		if (!ts.isStringLiteral(node))
			fail(node, 'Expected a literal string, not a computed target')
		return node.text
	}
	const matches: Array<{ config: ts.Expression; setup: ts.Expression }> = []
	function find(node: ts.Node) {
		if (
			ts.isCallExpression(node) &&
			ts.isPropertyAccessExpression(node.expression) &&
			node.expression.name.text === 'createMachine'
		) {
			const config = node.arguments[0]
			if (config && ts.isObjectLiteralExpression(config)) {
				const machineId = config.properties.find(
					(p) => ts.isPropertyAssignment(p) && p.name.getText(ast) === 'id',
				)
				if (
					machineId &&
					ts.isPropertyAssignment(machineId) &&
					ts.isStringLiteral(machineId.initializer) &&
					machineId.initializer.text === id
				) {
					const setup = node.expression.expression
					if (
						!ts.isCallExpression(setup) ||
						setup.expression.getText(ast) !== 'setup' ||
						!setup.arguments[0]
					)
						fail(node, 'Expected inline setup(...).createMachine(...)')
					matches.push({ config, setup: setup.arguments[0] })
				}
			}
		}
		ts.forEachChild(node, find)
	}
	find(ast)
	if (matches.length !== 1)
		throw new Error(
			`${file}: Expected exactly one literal machine id ${id}, found ${matches.length}`,
		)
	const config = object(matches[0]!.config)
	for (const key of ['on', 'always', 'after', 'invoke'])
		if (config.has(key))
			fail(config.get(key)!, 'Only state-local event handlers are supported')
	const states = object(
		config.get('states') ?? fail(matches[0]!.config, 'Missing states'),
	)
	const schemas = object(
		object(matches[0]!.setup).get('schemas') ??
			fail(matches[0]!.setup, 'Missing schemas'),
	)
	const events = object(
		schemas.get('events') ?? fail(matches[0]!.setup, 'Missing event schemas'),
	)
	const guardDefinitions = object(matches[0]!.setup).get('guards')
	const guards = guardDefinitions
		? object(guardDefinitions)
		: new Map<string, ts.Expression>()
	const graph: LifecycleGraph = {
		initial: literal(
			config.get('initial') ??
				fail(matches[0]!.config, 'Missing initial state'),
		),
		states: [...states.keys()],
		finals: [],
		declaredEvents: [...events.keys()],
		handlers: [],
		edges: [],
	}
	function edge(
		value: ts.Expression,
		source: string,
		event: string,
		guard: string,
	) {
		const returned = object(value)
		const target = returned.has('target')
			? literal(returned.get('target')!)
			: source
		if (!states.has(target)) fail(value, `Unknown destination ${target}`)
		graph.edges.push({ source, event, target, guard })
	}
	for (const [state, stateNode] of states) {
		const stateConfig = object(stateNode)
		if (
			stateConfig.has('states') ||
			stateConfig.has('always') ||
			stateConfig.has('after') ||
			stateConfig.has('invoke')
		)
			fail(stateNode, 'Only flat event-driven lifecycle states are supported')
		if (
			stateConfig.get('type') &&
			literal(stateConfig.get('type')!) === 'final'
		)
			graph.finals.push(state)
		if (!stateConfig.has('on')) continue
		for (const [event, handler] of object(stateConfig.get('on')!)) {
			if (ts.isIdentifier(handler) && handler.text === 'undefined') continue
			const value = unwrap(handler)
			const wrapper =
				ts.isArrowFunction(value) || ts.isFunctionExpression(value)
					? undefined
					: object(value)
			const fn = wrapper?.get('to') ?? value
			if (wrapper) {
				const allowed = wrapper.has('to')
					? ['to', 'description']
					: ['target', 'context', 'description', 'meta', 'reenter', 'input']
				for (const key of wrapper.keys())
					if (!allowed.includes(key))
						fail(handler, `Unsupported transition property ${key}`)
			}
			if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) {
				if (wrapper!.size === 0) continue
				if (wrapper!.has('to'))
					fail(handler, 'Transition function must be inline')
				graph.handlers.push({ source: state, event })
				edge(value, state, event, '')
				continue
			}
			graph.handlers.push({ source: state, event })
			if (
				fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ||
				(ts.isFunctionExpression(fn) && fn.asteriskToken)
			)
				fail(fn, 'Transition functions must be synchronous')
			const description = wrapper?.get('description')
			const otherwise = (label: string) =>
				label.startsWith('Otherwise (')
					? label.slice(11, -1)
					: `Otherwise (${label})`
			function condition(node: ts.Expression): string {
				node = unwrap(node)
				if (
					ts.isPrefixUnaryExpression(node) &&
					node.operator === ts.SyntaxKind.ExclamationToken
				)
					return otherwise(condition(node.operand))
				if (
					ts.isBinaryExpression(node) &&
					[
						ts.SyntaxKind.AmpersandAmpersandToken,
						ts.SyntaxKind.BarBarToken,
					].includes(node.operatorToken.kind)
				)
					return `(${condition(node.left)} ${node.operatorToken.getText(ast)} ${condition(node.right)})`
				if (
					ts.isCallExpression(node) &&
					ts.isPropertyAccessExpression(node.expression) &&
					node.expression.expression.getText(ast) === 'guards'
				) {
					const name = node.expression.name.text
					if (!guards.has(name)) fail(node, `Undeclared named guard ${name}`)
					const words = name
						.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
						.replaceAll('_', ' ')
					return words[0]!.toUpperCase() + words.slice(1).toLowerCase()
				}
				if (description) return literal(description)
				return fail(
					node,
					'Conditional transition requires a named guard or human-readable description',
				)
			}
			function returned(value: ts.Expression | undefined, paths: string[][]) {
				if (value) value = unwrap(value)
				if (!value || (ts.isIdentifier(value) && value.text === 'undefined'))
					return
				for (const path of paths) edge(value, state, event, path.join(' && '))
			}
			function statements(
				nodes: readonly ts.Statement[],
				paths: string[][],
			): string[][] {
				for (const node of nodes) {
					if (!paths.length) fail(node, 'Unreachable transition statement')
					if (ts.isReturnStatement(node)) {
						returned(node.expression, paths)
						paths = []
					} else if (ts.isIfStatement(node)) {
						const label = condition(node.expression)
						const branch = (body: ts.Statement, next: string[][]) =>
							statements(ts.isBlock(body) ? body.statements : [body], next)
						const yes = branch(
							node.thenStatement,
							paths.map((p) => [...p, label]),
						)
						const no = paths.map((p) => [...p, otherwise(label)])
						paths = [
							...yes,
							...(node.elseStatement ? branch(node.elseStatement, no) : no),
						]
					} else if (ts.isBlock(node))
						paths = statements(node.statements, paths)
					else if (
						!ts.isExpressionStatement(node) &&
						!ts.isVariableStatement(node) &&
						!ts.isEmptyStatement(node)
					)
						fail(node, 'Unsupported control flow in transition')
				}
				return paths
			}
			if (ts.isBlock(fn.body)) statements(fn.body.statements, [[]])
			else returned(fn.body, [[]])
		}
	}
	if (!states.has(graph.initial))
		fail(matches[0]!.config, 'Initial state is not declared')
	return graph
}

export function renderStateMachineMermaid(graph: LifecycleGraph): string {
	const id = (state: string) =>
		state.includes('-') ? `__state_${graph.states.indexOf(state)}` : state
	return [
		'stateDiagram-v2',
		...graph.states
			.filter((state) => state.includes('-'))
			.map((state) => `    state "${state}" as ${id(state)}`),
		`    [*] --> ${id(graph.initial)}`,
		...graph.edges.map(
			(edge) =>
				`    ${id(edge.source)} --> ${id(edge.target)}: ${edge.event}${edge.guard ? ` [${edge.guard}]` : ''}`,
		),
		...graph.finals.map((state) => `    ${id(state)} --> [*]`),
	].join('\n')
}
