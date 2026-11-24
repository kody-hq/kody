/**
 * Request-path safety rules: outbound deadlines, floating promises, and
 * swallowed errors. They are syntactic on purpose (no type information), so
 * each rule names the shapes it checks. Files in scope are listed in the
 * request-path-safety override in `tools/oxlint/oxlint-rules.json`.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const DEADLINE_HELPER = 'withDeadline'
const ERROR_REPORTERS = new Set([
	'reportHandledError',
	'reportConsumerError',
	'reportConsumerWarning',
])
/** Queue message settlement calls; only `settleQueueBatch` may make them. */
const QUEUE_SETTLEMENT_METHODS = new Set(['ack', 'retry', 'ackAll', 'retryAll'])
/**
 * Boundary helpers that do outbound I/O inside (D1, Durable Objects, the
 * Artifacts repo, routed context runs). A call to one is an outbound call.
 * Keys are repo-relative module paths; widen as more boundaries are covered.
 */
const OUTBOUND_IMPORTS = {
	'packages/worker/src/authorization/authorize.ts': [
		'authorizePackageWrite',
		'computeEffectivePermissions',
	],
	'packages/worker/src/execution-contexts/flag.ts': [
		'isExecutionContextsEnabledFor',
	],
	'packages/worker/src/execution-contexts/routing.ts': ['routeExecute'],
	'packages/worker/src/execution-contexts/store.ts': ['getChain'],
	'packages/worker/src/feature-flags/service.ts': ['isFeatureEnabled'],
	'packages/worker/src/mcp/capabilities/packages/resolve-package-source.ts': [
		'resolveOwnedPackageSource',
	],
	'packages/worker/src/package-registry/package-owner.ts': [
		'resolvePackageOwnerContext',
	],
	'packages/worker/src/package-runtime/module-graph-hydration.ts': [
		'resolveCurrentDynamicPackageArtifact',
	],
	'packages/worker/src/package-runtime/module-graph-workspace.ts': [
		'resolveKodyDependenciesForEntryPoint',
	],
	'packages/worker/src/package-runtime/published-bundle-artifact-persist.ts': [
		'persistPublishedPackageArtifactTargets',
	],
	'packages/worker/src/repo/artifact-file.ts': ['readArtifactFileAtCommit'],
	'packages/worker/src/repo/artifacts.ts': [
		'resolveArtifactSourceHead',
		'resolveArtifactSourceRepo',
	],
	'packages/worker/src/run-records/service.ts': ['getRunRecord'],
	'packages/worker/src/webhooks/delivery.ts': [
		'dispatchWebhookInvocation',
		'markAckWebhookDelivery',
		'recordWebhookDelivery',
		'startAckWebhookDeliveryAttempt',
	],
	'packages/worker/src/webhooks/dispatch-payload-store.ts': [
		'deleteWebhookDispatchPayload',
		'hydrateWebhookDispatchQueueMessage',
	],
	'packages/jobs-worker/src/store.ts': [
		'advanceStuckSkippedJobNextRunAt',
		'getWorkerStateValue',
		'putWorkerStateValue',
	],
}
/** Artifacts repo handles: every method is an RPC. */
const ARTIFACT_REPO_RECEIVER_PATTERN = /^repo$|ArtifactRepo$/
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
/** Typed-failure builders and exhaustive mappers, e.g. `deadlineFailure`, `mapGuestPurgeFailure`. */
const FAILURE_CALL_PATTERN = /Failure$/
/** Local collectors that gather errors the caller later throws, e.g. `recordInventoryError`. */
const ERROR_RECORDER_PATTERN = /^record\w*Error$/
/** Edge mappers that turn an error into the error response, e.g. `apiErrorResponse`. */
const ERROR_RESPONSE_PATTERN = /ErrorResponse$/

const importAliases = [
	['#worker/', 'packages/worker/src/'],
	['#mcp/', 'packages/worker/src/mcp/'],
	['#app/', 'packages/worker/src/app/'],
	['#universal/', 'packages/worker/universal/'],
	['@kody-internal/shared/', 'packages/shared/src/'],
]

/** Absolute path of a relative or aliased `.ts` import, or null. */
function resolveImport(filename, source) {
	let resolved = null
	if (source.startsWith('./') || source.startsWith('../')) {
		resolved = path.resolve(path.dirname(filename), source)
	} else {
		const alias = importAliases.find(([prefix]) => source.startsWith(prefix))
		if (alias) {
			resolved = path.join(repoRoot, alias[1], source.slice(alias[0].length))
		}
	}
	return resolved?.endsWith('.ts') ? resolved : null
}

function repoPath(absolutePath) {
	return path.relative(repoRoot, absolutePath).split(path.sep).join('/')
}

const ASYNC_EXPORT_PATTERNS = [
	/export\s+async\s+function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
	/export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*async\b/g,
]
const asyncExportCache = new Map()

/** Names a module exports as async functions (read from its source text). */
function asyncExportsOf(absolutePath) {
	let names = asyncExportCache.get(absolutePath)
	if (names) return names
	names = new Set()
	if (existsSync(absolutePath)) {
		const text = readFileSync(absolutePath, 'utf8')
		for (const pattern of ASYNC_EXPORT_PATTERNS) {
			for (const match of text.matchAll(pattern)) names.add(match[1])
		}
	}
	asyncExportCache.set(absolutePath, names)
	return names
}

function importedName(specifier) {
	if (specifier.type === 'ImportDefaultSpecifier') return 'default'
	if (specifier.type !== 'ImportSpecifier') return null
	return specifier.imported.type === 'Identifier'
		? specifier.imported.name
		: specifier.imported.value
}

/** Local names this import binds to outbound boundary helpers. */
function outboundLocals(filename, node) {
	const resolved = resolveImport(filename, node.source.value)
	const names = resolved ? OUTBOUND_IMPORTS[repoPath(resolved)] : undefined
	if (!names || node.importKind === 'type') return []
	return node.specifiers
		.filter((specifier) => names.includes(importedName(specifier)))
		.map((specifier) => specifier.local.name)
}

/** Local names this import binds to async functions. */
function asyncLocals(filename, node) {
	const resolved = resolveImport(filename, node.source.value)
	if (!resolved || node.importKind === 'type') return []
	const asyncNames = asyncExportsOf(resolved)
	return node.specifiers
		.filter((specifier) => asyncNames.has(importedName(specifier)))
		.map((specifier) => specifier.local.name)
}

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

function isOutboundCall(call, outboundNames = new Set()) {
	const callee = call.callee
	if (callee.type === 'Identifier') {
		return (
			callee.name === 'fetch' ||
			RPC_FACTORY_PATTERN.test(callee.name) ||
			outboundNames.has(callee.name)
		)
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
	if (receiver && ARTIFACT_REPO_RECEIVER_PATTERN.test(receiver)) return true
	if (callee.object.type === 'CallExpression') {
		const factory = calleeName(callee.object)
		return Boolean(factory && STUB_PATTERN.test(factory))
	}
	return (
		callee.object.type === 'Identifier' &&
		(STUB_PATTERN.test(callee.object.name) ||
			outboundNames.has(callee.object.name))
	)
}

/** `const session = sessionStub(env, id)` makes `session` a stub receiver. */
function stubBinding(node) {
	if (node.id.type !== 'Identifier' || !node.init) return null
	const init =
		node.init.type === 'AwaitExpression' ? node.init.argument : node.init
	if (init.type !== 'CallExpression') return null
	const factory = calleeName(init)
	return factory && STUB_PATTERN.test(factory) ? node.id.name : null
}

function isInsideDeadline(node) {
	let child = node
	let current = node.parent
	while (current) {
		if (
			current.type === 'CallExpression' &&
			current.arguments[1] === child &&
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
		ERROR_REPORTERS.has(name ?? '') ||
		FAILURE_CALL_PATTERN.test(name ?? '') ||
		ERROR_RECORDER_PATTERN.test(name ?? '') ||
		ERROR_RESPONSE_PATTERN.test(name ?? '')
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
				'Require outbound calls (D1, KV, R2, Durable Object RPC, Artifacts repo, routed context runs, fetch) to run inside withDeadline.',
		},
		schema: [],
		messages: {
			missingDeadline:
				'Wrap this outbound call in withDeadline({ label, timeoutMs }, (signal) => ...) from #worker/outbound/with-deadline.ts so a hung call fails with a typed DeadlineExceededError. Pick timeoutMs explicitly; there is no default. See docs/contributing/request-handlers.md.',
		},
	},
	createOnce(context) {
		let outboundNames = new Set()
		return {
			before() {
				outboundNames = new Set()
			},
			ImportDeclaration(node) {
				for (const name of outboundLocals(context.filename, node)) {
					outboundNames.add(name)
				}
			},
			VariableDeclarator(node) {
				const name = stubBinding(node)
				if (name) outboundNames.add(name)
			},
			CallExpression(node) {
				if (!isOutboundCall(node, outboundNames) || isInsideDeadline(node))
					return
				context.report({ node, messageId: 'missingDeadline' })
			},
		}
	},
}

export const noFloatingPromiseRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Forbid promises that are not awaited, returned, or handed to waitUntil, including calls to imported async functions.',
		},
		schema: [],
		messages: {
			floating:
				'This promise floats: await it, return it, or pass it to waitUntil. The request can finish (and the isolate stop) before a floating promise settles, and its rejection is never observed. See docs/contributing/request-handlers.md.',
		},
	},
	createOnce(context) {
		let asyncNames = new Set()
		let outboundNames = new Set()
		let statements = []
		return {
			before() {
				asyncNames = new Set()
				outboundNames = new Set()
				statements = []
			},
			ImportDeclaration(node) {
				for (const name of asyncLocals(context.filename, node)) {
					asyncNames.add(name)
				}
				for (const name of outboundLocals(context.filename, node)) {
					outboundNames.add(name)
				}
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
						isOutboundCall(expression, outboundNames)
					if (returnsPromise)
						context.report({ node: statement, messageId: 'floating' })
				}
			},
		}
	},
}

export const noSwallowedErrorRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Forbid catch blocks and .catch handlers that neither rethrow, return a typed failure, nor report through reportHandledError.',
		},
		schema: [],
		messages: {
			swallowed:
				'This handler swallows the error. Rethrow it, return a typed failure ({ kind: ... } or a ...Failure(...) builder) for the edge mapper, map it with an ...ErrorResponse(...) edge mapper, push it onto warnings/failures, or report it with reportHandledError from #worker/outbound/typed-failure.ts (reportConsumerError or reportConsumerWarning from @kody-internal/shared/consumer-errors.ts in queue consumers, alarms, and crons). See docs/contributing/request-handlers.md.',
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

export const noDirectQueueSettlementRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Queue consumers settle messages through settleQueueBatch, not by calling ack/retry directly.',
		},
		schema: [],
		messages: {
			direct:
				'Return a QueueDisposition from the decide callback of settleQueueBatch (@kody-internal/shared/queue-settlement.ts) instead of calling {{method}}() here. It settles every message exactly once, retries a thrown decision, and runs afterAck cleanup only after the ack. See docs/contributing/request-handlers.md.',
		},
	},
	createOnce(context) {
		return {
			CallExpression(node) {
				if (node.callee.type !== 'MemberExpression') return
				const method = propertyName(node.callee)
				if (!QUEUE_SETTLEMENT_METHODS.has(method ?? '')) return
				if (node.arguments.length > 1) return
				context.report({ node, messageId: 'direct', data: { method } })
			},
		}
	},
}
