/**
 * Lane-safety rules for scheduled cleanup and purge code. They are syntactic
 * on purpose: no type information, so each rule names the shapes it checks.
 * Scope lives in `tools/oxlint/oxlint-rules.json` (the lane-safety override).
 */

const DEADLINE_HELPER = 'withDeadline'
const LANE_REPORTER = 'reportLaneError'
const D1_TERMINAL_METHODS = new Set(['run', 'all', 'first', 'raw'])
const D1_STATEMENT_METHODS = new Set(['prepare', 'bind'])
const STORAGE_METHODS = new Set([
	'get',
	'getWithMetadata',
	'put',
	'list',
	'delete',
	'head',
])
const STORAGE_RECEIVER_PATTERN =
	/^(?:kv|blobs|bucket|storage|r2)$|(?:_KV|_BLOBS|_BUCKET|_R2|Kv|KV|Blobs|Bucket)$/
const RPC_FACTORY_PATTERN = /Rpc$/
const STUB_PATTERN = /^stub$|Stub$/
const DB_RECEIVER_PATTERN = /db$/i
const PROMISE_CHAIN_METHODS = new Set(['then', 'catch', 'finally'])
const PROMISE_STATICS = new Set(['all', 'allSettled', 'any', 'race'])
const ERROR_COLLECTORS = new Set(['warnings', 'failures'])
/** Per-lane exhaustive failure mappers, e.g. `mapGuestPurgeFailure`. */
const LANE_FAILURE_MAPPER_PATTERN = /^map\w*Failure$/
/** Local collectors that gather errors the lane later throws, e.g. `recordInventoryError`. */
const ERROR_RECORDER_PATTERN = /^record\w*Error$/

function isNode(value) {
	return (
		value !== null &&
		typeof value === 'object' &&
		typeof value.type === 'string'
	)
}

function isFunction(node) {
	return (
		node?.type === 'ArrowFunctionExpression' ||
		node?.type === 'FunctionExpression' ||
		node?.type === 'FunctionDeclaration'
	)
}

function propertyName(member) {
	if (member?.type !== 'MemberExpression' || member.computed) return null
	return member.property.type === 'Identifier' ? member.property.name : null
}

function receiverName(expression) {
	if (expression?.type === 'Identifier') return expression.name
	if (expression?.type === 'MemberExpression') return propertyName(expression)
	return null
}

function calleeName(call) {
	if (call.callee.type === 'Identifier') return call.callee.name
	return propertyName(call.callee)
}

/** True when a member-call chain below `expression` calls one of `methods`. */
function chainCalls(expression, methods) {
	let current = expression
	while (current) {
		if (current.type === 'CallExpression') {
			const name = propertyName(current.callee)
			if (name && methods.has(name)) return true
			current =
				current.callee.type === 'MemberExpression'
					? current.callee.object
					: null
		} else if (current.type === 'MemberExpression') {
			current = current.object
		} else {
			return false
		}
	}
	return false
}

function isOutboundCall(call) {
	const callee = call.callee
	if (callee.type === 'Identifier') {
		return callee.name === 'fetch' || RPC_FACTORY_PATTERN.test(callee.name)
	}
	const method = propertyName(callee)
	if (!method) return false
	if (method === 'fetch' || method === 'batch') return true
	const receiver = receiverName(callee.object)
	if (
		D1_TERMINAL_METHODS.has(method) &&
		chainCalls(callee.object, D1_STATEMENT_METHODS)
	) {
		return true
	}
	if (method === 'exec' && receiver && DB_RECEIVER_PATTERN.test(receiver))
		return true
	if (
		STORAGE_METHODS.has(method) &&
		receiver &&
		STORAGE_RECEIVER_PATTERN.test(receiver)
	) {
		return true
	}
	return (
		callee.object.type === 'Identifier' && STUB_PATTERN.test(callee.object.name)
	)
}

function isInsideDeadline(node) {
	let child = node
	let current = node.parent
	while (current) {
		if (
			current.type === 'CallExpression' &&
			current.callee !== child &&
			calleeName(current) === DEADLINE_HELPER
		) {
			return true
		}
		child = current
		current = current.parent
	}
	return false
}

/** Visit `node` and its descendants, skipping nested function bodies. */
function someDescendant(node, predicate) {
	if (predicate(node)) return true
	for (const key of Object.keys(node)) {
		if (key === 'parent') continue
		const value = node[key]
		const children = Array.isArray(value) ? value : [value]
		for (const child of children) {
			if (!isNode(child) || isFunction(child)) continue
			if (someDescendant(child, predicate)) return true
		}
	}
	return false
}

function isTypedFailure(expression) {
	return (
		expression?.type === 'ObjectExpression' &&
		expression.properties.some(
			(property) =>
				property.type === 'Property' &&
				!property.computed &&
				property.key.type === 'Identifier' &&
				property.key.name === 'kind',
		)
	)
}

function handlesError(node) {
	if (node.type === 'ThrowStatement') return true
	if (node.type === 'ReturnStatement') return isTypedFailure(node.argument)
	if (node.type !== 'CallExpression') return false
	const name = calleeName(node)
	if (
		name === LANE_REPORTER ||
		LANE_FAILURE_MAPPER_PATTERN.test(name ?? '') ||
		ERROR_RECORDER_PATTERN.test(name ?? '')
	) {
		return true
	}
	return (
		propertyName(node.callee) === 'push' &&
		ERROR_COLLECTORS.has(receiverName(node.callee.object))
	)
}

function handlerHandlesError(handler) {
	if (!isFunction(handler)) return false
	if (handler.body.type !== 'BlockStatement') {
		return (
			isTypedFailure(handler.body) || someDescendant(handler.body, handlesError)
		)
	}
	return someDescendant(handler.body, handlesError)
}

export const requireOutboundDeadlineRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Require outbound calls (D1, KV, R2, Durable Object RPC, fetch) in scheduled lane code to run inside withDeadline.',
		},
		schema: [],
		messages: {
			missingDeadline:
				'Wrap this outbound call in withDeadline({ label, timeoutMs }, (signal) => ...) from #worker/outbound/with-deadline.ts so a hung call fails the lane with a typed DeadlineExceededError.',
		},
	},
	createOnce(context) {
		return {
			CallExpression(node) {
				if (!isOutboundCall(node) || isInsideDeadline(node)) return
				context.report({ node, messageId: 'missingDeadline' })
			},
		}
	},
}

export const noFloatingLanePromiseRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Forbid promises in scheduled lane code that are not awaited, returned, or handed to waitUntil.',
		},
		schema: [],
		messages: {
			floating:
				'This promise floats: await it, return it, or pass it to waitUntil. The lane can finish (and the isolate stop) before a floating promise settles, and its rejection is never observed.',
		},
	},
	createOnce(context) {
		let asyncNames = new Set()
		let statements = []
		return {
			before() {
				asyncNames = new Set()
				statements = []
			},
			FunctionDeclaration(node) {
				if (node.async && node.id) asyncNames.add(node.id.name)
			},
			VariableDeclarator(node) {
				if (
					node.id.type === 'Identifier' &&
					isFunction(node.init) &&
					node.init.async
				) {
					asyncNames.add(node.id.name)
				}
			},
			ExpressionStatement(node) {
				statements.push(node)
			},
			'Program:exit'() {
				for (const statement of statements) {
					let expression = statement.expression
					if (
						expression.type === 'UnaryExpression' &&
						expression.operator === 'void'
					) {
						if (expression.argument.type === 'CallExpression') {
							context.report({ node: statement, messageId: 'floating' })
						}
						continue
					}
					if (expression.type === 'ChainExpression')
						expression = expression.expression
					if (expression.type === 'NewExpression') {
						if (
							expression.callee.type === 'Identifier' &&
							expression.callee.name === 'Promise'
						) {
							context.report({ node: statement, messageId: 'floating' })
						}
						continue
					}
					if (expression.type !== 'CallExpression') continue
					const name = calleeName(expression)
					const receiver =
						expression.callee.type === 'MemberExpression'
							? receiverName(expression.callee.object)
							: null
					const returnsPromise =
						(name !== null &&
							PROMISE_CHAIN_METHODS.has(name) &&
							expression.callee.type === 'MemberExpression') ||
						(receiver === 'Promise' && PROMISE_STATICS.has(name)) ||
						(expression.callee.type === 'Identifier' && asyncNames.has(name)) ||
						name === DEADLINE_HELPER ||
						name === 'runD1WithRetry' ||
						isOutboundCall(expression)
					if (returnsPromise)
						context.report({ node: statement, messageId: 'floating' })
				}
			},
		}
	},
}

export const noSwallowedLaneErrorRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Forbid catch blocks and .catch handlers in scheduled lane code that neither rethrow, return a typed failure, nor report through reportLaneError.',
		},
		schema: [],
		messages: {
			swallowed:
				'This handler swallows the error. Rethrow it, return a typed failure ({ kind: ... }) for the lane mapper, hand it to the lane failure mapper (map...Failure), push it onto the lane result warnings/failures, or report it with reportLaneError from #worker/scheduled/lane-failure.ts.',
		},
	},
	createOnce(context) {
		return {
			CatchClause(node) {
				if (someDescendant(node.body, handlesError)) return
				context.report({ node, messageId: 'swallowed' })
			},
			CallExpression(node) {
				const method = propertyName(node.callee)
				const handler =
					method === 'catch'
						? node.arguments[0]
						: method === 'then'
							? node.arguments[1]
							: undefined
				if (!handler || handlerHandlesError(handler)) return
				context.report({ node: handler, messageId: 'swallowed' })
			},
		}
	},
}
