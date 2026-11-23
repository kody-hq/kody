import {
	noFloatingPromiseRule,
	noSwallowedErrorRule,
	requireOutboundDeadlineRule,
} from './request-path-safety.js'
import {
	findOversizedOfficialGuideSections,
	isOfficialGuideCatalogFile,
} from './guide-section-budget.js'
import {
	findTautologicalAbsenceMatches,
	isTestPath,
	loadTautologicalAbsenceCorpus,
	locForRange,
	otherContentsFromCorpus,
	repoRelativePath,
} from './tautological-absence.js'

const EXAMPLE_IDENTIFIER = '__oxlint_plugin_example__'
const CLIENT_ROUTE_FILE_PATTERN =
	/(^|\/)packages\/worker\/client\/routes\/.+\.(ts|tsx)$/
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[^.]+$/
const SHARED_LOADER_DATA_TYPE_NAMES = new Set([
	'AccountSecretListItem',
	'AccountSecretDetail',
	'AccountSecretsLoaderData',
	'AccountPackagesLoaderData',
	'AccountIntegrationsLoaderData',
	'AccountIntegrationListItem',
])

const noExampleIdentifierRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Demonstrates how to author a custom oxlint JS plugin rule in this repo.',
		},
		schema: [],
		messages: {
			avoidExampleIdentifier:
				'Avoid using __oxlint_plugin_example__. This identifier exists only to verify the custom oxlint rule example.',
		},
	},
	createOnce(context) {
		return {
			Identifier(node) {
				if (node.name !== EXAMPLE_IDENTIFIER) return
				context.report({ node, messageId: 'avoidExampleIdentifier' })
			},
		}
	},
}

function isLiteralFrameSrc(value) {
	if (!value) return false
	if (value.type === 'Literal' && typeof value.value === 'string') return true
	if (value.type !== 'JSXExpressionContainer') return false
	const expression = value.expression
	if (expression.type === 'Literal' && typeof expression.value === 'string') {
		return true
	}
	return expression.type === 'TemplateLiteral'
}

function normalizeFilePath(filename) {
	return typeof filename === 'string' ? filename.replaceAll('\\', '/') : ''
}

function isClientRouteFile(filename) {
	return CLIENT_ROUTE_FILE_PATTERN.test(normalizeFilePath(filename))
}

function isTestFile(filename) {
	return TEST_FILE_PATTERN.test(normalizeFilePath(filename))
}

function shouldImportSharedLoaderDataType(typeName) {
	if (!typeName) return false
	return (
		typeName.endsWith('LoaderData') ||
		SHARED_LOADER_DATA_TYPE_NAMES.has(typeName)
	)
}

function getDeclaredTypeName(node) {
	if (!node?.id || node.id.type !== 'Identifier') return null
	return node.id.name
}

const noLiteralFrameSrcRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Require typed route href() expressions for Remix Frame src props.',
		},
		schema: [],
		messages: {
			useRoutesHref:
				'<Frame src> must use routes.<name>.href(...) instead of a string or template literal.',
		},
	},
	createOnce(context) {
		return {
			JSXOpeningElement(node) {
				if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'Frame') {
					return
				}

				for (const attribute of node.attributes) {
					if (attribute.type !== 'JSXAttribute') continue
					if (
						attribute.name.type !== 'JSXIdentifier' ||
						attribute.name.name !== 'src'
					) {
						continue
					}
					if (!isLiteralFrameSrc(attribute.value)) continue
					context.report({ node: attribute, messageId: 'useRoutesHref' })
				}
			},
		}
	},
}

const preferLoaderDataTypesRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Require client routes to import shared loader-data payload types instead of redeclaring them locally.',
		},
		schema: [],
		messages: {
			importFromLoaderData:
				'Import shared payload types from #universal/loader-data.ts instead of redeclaring this type in a client route.',
		},
	},
	createOnce(context) {
		let shouldCheckCurrentFile = false

		function reportIfNeeded(node) {
			if (!shouldCheckCurrentFile) return
			const typeName = getDeclaredTypeName(node)
			if (!shouldImportSharedLoaderDataType(typeName)) return
			context.report({ node, messageId: 'importFromLoaderData' })
		}

		return {
			Program() {
				shouldCheckCurrentFile = isClientRouteFile(context.filename)
			},
			TSTypeAliasDeclaration(node) {
				reportIfNeeded(node)
			},
			TSInterfaceDeclaration(node) {
				reportIfNeeded(node)
			},
		}
	},
}

/**
 * Enforced import direction between worker layers. `#app/*` is the HTTP/UI
 * layer, `#mcp/*` is the capability layer beneath it, `#universal/*` is the
 * client-safe contract layer both the browser bundle and the worker may
 * import, and the rest of `#worker/*` holds server primitives. Imports may
 * only point downward, so shared code has to be extracted into a neutral
 * `#worker/*` or `#universal/*` module instead of growing a cycle.
 *
 * Each boundary lists the `allowedSpecifiers` that still cross it. Add to a
 * list only with a `reason` explaining why the edge cannot be extracted yet —
 * a new violation should fail lint, not quietly join the list.
 */
export const importBoundaries = [
	{
		id: 'mcp-to-app',
		filePattern: /(^|\/)packages\/worker\/src\/mcp\/.+$/,
		forbiddenPrefixes: ['#app/'],
		message:
			'#mcp/* must not import from #app/*. Extract the shared code into a neutral #worker/* or #universal/* module (see docs/contributing/import-boundaries.md).',
		allowedSpecifiers: [],
		/**
		 * Never allowlisted: request handlers are the top of the app layer, so
		 * a capability that needs handler logic is always the wrong shape.
		 */
		neverAllowedPrefix: '#app/handlers/',
		neverAllowedMessage:
			'#mcp/* must never import an #app/handlers/* request handler. Move the shared logic into a neutral #worker/* or #universal/* module.',
	},
	{
		id: 'package-registry-to-mcp',
		filePattern: /(^|\/)packages\/worker\/src\/package-registry\/.+$/,
		forbiddenPrefixes: ['#mcp/'],
		message:
			'#worker/package-registry/* must not import from #mcp/*. Extract the shared code into a neutral #worker/* or #universal/* module (see docs/contributing/import-boundaries.md).',
		allowedSpecifiers: [],
		neverAllowedPrefix: null,
		neverAllowedMessage: null,
	},
	{
		id: 'client-to-server',
		filePattern: /(^|\/)packages\/worker\/(client|universal)\/.+$/,
		forbiddenPrefixes: ['#app/', '#worker/', '#mcp/'],
		message:
			'Client and universal modules must not import #app/*, #worker/*, or #mcp/*. Put the shared contract in #universal/* (see docs/contributing/import-boundaries.md).',
		allowedSpecifiers: [],
		neverAllowedPrefix: null,
		neverAllowedMessage: null,
		skipTestFiles: true,
	},
	{
		id: 'universal-to-client',
		filePattern: /(^|\/)packages\/worker\/universal\/.+$/,
		forbiddenPrefixes: ['#client/'],
		message:
			'#universal/* must not import #client/*. Shared UI tokens and components belong in #universal/* so SSR and the client bundle can both use them.',
		allowedSpecifiers: [],
		neverAllowedPrefix: null,
		neverAllowedMessage: null,
	},
]

function getForbiddenPrefixes(boundary) {
	if (Array.isArray(boundary.forbiddenPrefixes)) {
		return boundary.forbiddenPrefixes
	}
	return boundary.forbiddenPrefix ? [boundary.forbiddenPrefix] : []
}

function findBoundaryViolation(boundary, specifier) {
	if (
		boundary.neverAllowedPrefix &&
		specifier.startsWith(boundary.neverAllowedPrefix)
	) {
		return boundary.neverAllowedMessage
	}
	const matchesForbidden = getForbiddenPrefixes(boundary).some((prefix) =>
		specifier.startsWith(prefix),
	)
	if (!matchesForbidden) return null
	const allowed = boundary.allowedSpecifiers.some(
		(entry) => entry.specifier === specifier,
	)
	return allowed ? null : boundary.message
}

/**
 * Boundaries that apply to `filename`. Exported so the rule and its test agree
 * on which files each boundary covers.
 */
export function getImportBoundariesForFile(filename) {
	const normalized = normalizeFilePath(filename)
	return importBoundaries.filter((boundary) => {
		if (boundary.skipTestFiles && isTestFile(normalized)) return false
		return boundary.filePattern.test(normalized)
	})
}

/**
 * The message a boundary would report for `specifier`, or null when the import
 * is allowed. Exported for `import-boundaries.node.test.ts`.
 */
export function findImportBoundaryViolation(filename, specifier) {
	for (const boundary of getImportBoundariesForFile(filename)) {
		const detail = findBoundaryViolation(boundary, specifier)
		if (detail) return detail
	}
	return null
}

let tautologicalAbsenceCorpus = null

function tautologicalAbsenceCorpusFor() {
	if (!tautologicalAbsenceCorpus) {
		tautologicalAbsenceCorpus = loadTautologicalAbsenceCorpus()
	}
	return tautologicalAbsenceCorpus
}

let officialGuideSectionOverflows = null

function officialGuideSectionOverflowsFor() {
	if (!officialGuideSectionOverflows) {
		officialGuideSectionOverflows = findOversizedOfficialGuideSections()
	}
	return officialGuideSectionOverflows
}

const noOversizedGuideSectionRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Reject official guide sections that exceed the search body budget (maxChars minus the entity header) so guide:{id}#{slug} can return the full heading.',
		},
		schema: [],
		messages: {
			oversizedSection:
				'Official guide section "{{file}}#{{slug}}" is {{chars}} characters (limit {{limit}} after the search entity header). Split the heading or move detail so search({ entity: "guide:{id}#{slug}" }) can return the full section.',
		},
	},
	createOnce(context) {
		return {
			Program(node) {
				// createOnce cannot read context.filename at setup. Official
				// guides are markdown, so this visitor reports on the catalog
				// TypeScript haystack after walking docs/guides/.
				if (!isOfficialGuideCatalogFile(context.filename)) return
				for (const overflow of officialGuideSectionOverflowsFor()) {
					context.report({
						node,
						messageId: 'oversizedSection',
						data: {
							file: overflow.file,
							slug: overflow.slug,
							chars: String(overflow.chars),
							limit: String(overflow.limit),
						},
					})
				}
			},
		}
	},
}

const noTautologicalAbsenceRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Reject instructional-copy not.toContain leftovers when the string exists only as that absence assertion.',
		},
		schema: [],
		messages: {
			vanishedCopy:
				'Do not keep a lone not.toContain of copy that no longer exists in the repo ({{needle}}). Fine while deleting; drop the assertion before commit. Keep absence checks that flip state or still appear on another path.',
		},
	},
	createOnce(context) {
		return {
			Program() {
				const relativePath = repoRelativePath(context.filename)
				if (!isTestPath(relativePath)) return
				const source = context.sourceCode.getText()
				const matches = findTautologicalAbsenceMatches({
					relativePath,
					content: source,
					otherContents: otherContentsFromCorpus(
						tautologicalAbsenceCorpusFor(),
						relativePath,
					),
				})
				for (const match of matches) {
					context.report({
						loc: locForRange(source, match.start, match.end),
						messageId: 'vanishedCopy',
						data: { needle: JSON.stringify(match.needle) },
					})
				}
			},
		}
	},
}

const enforceImportBoundariesRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Enforce worker layer import direction so mcp/app, package-registry/mcp, and client/server cycles cannot grow.',
		},
		schema: [],
		messages: {
			crossesBoundary: '{{detail}}',
		},
	},
	createOnce(context) {
		let activeBoundaries = []

		function check(node, specifier) {
			if (typeof specifier !== 'string') return
			for (const boundary of activeBoundaries) {
				const detail = findBoundaryViolation(boundary, specifier)
				if (!detail) continue
				context.report({
					node,
					messageId: 'crossesBoundary',
					data: { detail },
				})
				return
			}
		}

		return {
			Program() {
				activeBoundaries = getImportBoundariesForFile(context.filename)
			},
			ImportDeclaration(node) {
				check(node, node.source.value)
			},
			ExportNamedDeclaration(node) {
				if (!node.source) return
				check(node, node.source.value)
			},
			ExportAllDeclaration(node) {
				check(node, node.source.value)
			},
			ImportExpression(node) {
				if (node.source.type !== 'Literal') return
				check(node, node.source.value)
			},
			// `vi.mock('#app/...')` reaches across the same boundary, so tests
			// cannot route around the rule.
			CallExpression(node) {
				const [first] = node.arguments
				if (first?.type !== 'Literal') return
				if (
					node.callee.type === 'MemberExpression' &&
					node.callee.object.type === 'Identifier' &&
					node.callee.object.name === 'vi' &&
					node.callee.property.type === 'Identifier' &&
					(node.callee.property.name === 'mock' ||
						node.callee.property.name === 'unmock')
				) {
					check(node, first.value)
				}
			},
		}
	},
}

/**
 * The Workflows engine stops retrying a step only when the thrown error's name
 * is `NonRetryableError` (it cannot use `instanceof` across RPC). The
 * constructor's optional second argument overrides that name, so any second
 * argument silently turns a terminal failure into a retried one.
 */
const noNonRetryableErrorNameRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Forbid passing a custom name to NonRetryableError, which makes the Workflows engine retry the step.',
		},
		schema: [],
		messages: {
			customName:
				'Do not pass a name to NonRetryableError. The Workflows engine only skips retries when the error name is "NonRetryableError", so a custom name makes the step retry. Keep codes in the message instead.',
		},
	},
	createOnce(context) {
		return {
			NewExpression(node) {
				const callee = node.callee
				const calleeName =
					callee.type === 'Identifier'
						? callee.name
						: callee.type === 'MemberExpression' &&
							  !callee.computed &&
							  callee.property.type === 'Identifier'
							? callee.property.name
							: null
				if (calleeName !== 'NonRetryableError') return
				const passesName =
					node.arguments.length > 1 ||
					node.arguments.some((argument) => argument.type === 'SpreadElement')
				if (!passesName) return
				context.report({ node, messageId: 'customName' })
			},
		}
	},
}

const USER_METER_BUDGET_CHECK_METHODS = new Set([
	'checkBudgetAndRecord',
	'assertWithinBudgetAndRecord',
])
const USER_METER_BUDGET_CHECK_ALLOWED_FILES = [
	'packages/worker/src/entitlements/user-meter-client.ts',
	'packages/worker/src/entitlements/user-meter-client.node.test.ts',
	'packages/worker/src/entitlements/user-meter-do.ts',
	'tools/oxlint/local-plugin.js',
	'tools/oxlint/user-meter-budget-check-via-helper.node.test.ts',
]

/**
 * The UserMeter budget check returns denials as data, so a direct call that
 * ignores the result would allow over-budget work. Every caller goes through
 * `checkUserMeterBudgetAndRecord`, which turns a denial into BudgetLimitError.
 */
const userMeterBudgetCheckViaHelperRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Only checkUserMeterBudgetAndRecord may call the UserMeter budget check RPC methods.',
		},
		schema: [],
		messages: {
			direct:
				'Call checkUserMeterBudgetAndRecord (entitlements/user-meter-client.ts) instead of the UserMeter {{name}} RPC. It refuses on denial and fails closed.',
		},
	},
	createOnce(context) {
		let allowed = false
		function check(node, name) {
			if (allowed || !USER_METER_BUDGET_CHECK_METHODS.has(name)) return
			context.report({ node, messageId: 'direct', data: { name } })
		}
		return {
			Program() {
				const filename = normalizeFilePath(context.filename)
				allowed = USER_METER_BUDGET_CHECK_ALLOWED_FILES.some((file) =>
					filename.endsWith(file),
				)
			},
			Identifier(node) {
				check(node, node.name)
			},
			Literal(node) {
				if (typeof node.value === 'string') check(node, node.value)
			},
			TemplateElement(node) {
				check(node, node.value.cooked)
			},
		}
	},
}

const noInlineTypeOnlyImportRule = {
	meta: {
		type: 'problem',
		fixable: 'code',
		docs: {
			description:
				'Require `import type` when every specifier is type-only, so the module stays off the Worker startup graph.',
		},
		schema: [],
		messages: {
			inlineTypeOnly:
				'Every specifier is type-only. Use `import type { ... }`: with verbatimModuleSyntax, `import { type X }` compiles to a side-effect import that keeps the module on the Worker startup graph.',
		},
	},
	createOnce(context) {
		return {
			ImportDeclaration(node) {
				if (node.importKind === 'type') return
				const specifiers = node.specifiers
				if (specifiers.length === 0) return
				const allInlineTypes = specifiers.every(
					(specifier) =>
						specifier.type === 'ImportSpecifier' &&
						specifier.importKind === 'type',
				)
				if (!allInlineTypes) return
				context.report({
					node,
					messageId: 'inlineTypeOnly',
					fix(fixer) {
						const importKeywordEnd = node.range[0] + 'import'.length
						return [
							fixer.insertTextAfterRange(
								[node.range[0], importKeywordEnd],
								' type',
							),
							...specifiers.map((specifier) =>
								fixer.removeRange([
									specifier.range[0],
									specifier.imported.range[0],
								]),
							),
						]
					},
				})
			},
		}
	},
}

const pillRadiusValues = new Set(['999px', '9999px'])
const buttonLikeTags = new Set(['button', 'a', 'SiteLink'])

function isPillRadius(value) {
	if (value.type === 'Literal') return pillRadiusValues.has(value.value)
	return (
		value.type === 'MemberExpression' &&
		value.object.type === 'Identifier' &&
		value.object.name === 'radius' &&
		value.property.type === 'Identifier' &&
		value.property.name === 'full'
	)
}

function propertyName(property) {
	if (property.type !== 'Property') return null
	if (property.key.type === 'Identifier') return property.key.name
	if (property.key.type === 'Literal') return String(property.key.value)
	return null
}

function containsButtonCssCall(node) {
	if (!node || typeof node !== 'object') return false
	if (
		node.type === 'CallExpression' &&
		node.callee.type === 'Identifier' &&
		node.callee.name === 'getButtonCss'
	) {
		return true
	}
	if (node.type === 'ArrayExpression') {
		return node.elements.some(containsButtonCssCall)
	}
	if (node.type === 'ObjectExpression') {
		return node.properties.some(
			(property) =>
				property.type === 'SpreadElement' &&
				containsButtonCssCall(property.argument),
		)
	}
	if (node.type === 'ConditionalExpression') {
		return (
			containsButtonCssCall(node.consequent) ||
			containsButtonCssCall(node.alternate)
		)
	}
	return false
}

const formControlComponentFiles = [
	'/start/components/input.tsx',
	'/start/components/choice-controls.tsx',
]
const nativeOnlyInputTypes = new Set(['hidden', 'file', 'range', 'color'])

function staticJsxAttribute(node, name) {
	for (const attribute of node.attributes) {
		if (
			attribute.type !== 'JSXAttribute' ||
			attribute.name.type !== 'JSXIdentifier' ||
			attribute.name.name !== name
		) {
			continue
		}
		if (attribute.value?.type === 'Literal') return attribute.value.value
		if (
			attribute.value?.type === 'JSXExpressionContainer' &&
			attribute.value.expression.type === 'Literal'
		) {
			return attribute.value.expression.value
		}
		return null
	}
	return undefined
}

const noRawFormControlRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Render form controls through the shared library (start/components/input.tsx, choice-controls.tsx) so they share labels, focus rings, and the field look.',
		},
		schema: [],
		messages: {
			useComponent:
				'Render <{{component}}> from start/components/{{file}} instead of a raw <{{tag}}>. See docs/contributing/ui-components.md.',
		},
	},
	createOnce(context) {
		return {
			JSXOpeningElement(node) {
				if (node.name.type !== 'JSXIdentifier') return
				const tag = node.name.name
				if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') return
				const filename = context.filename
				if (!/\/packages\/worker\/(start|client)\//.test(filename)) return
				if (/\.test\.tsx?$/.test(filename)) return
				if (formControlComponentFiles.some((file) => filename.endsWith(file))) {
					return
				}
				let component = 'Input'
				let file = 'input.tsx'
				if (tag === 'select') component = 'Select'
				if (tag === 'textarea') component = 'Textarea'
				if (tag === 'input') {
					const type = staticJsxAttribute(node, 'type')
					if (typeof type === 'string' && nativeOnlyInputTypes.has(type)) return
					if (type === 'checkbox' || type === 'radio') {
						component = type === 'checkbox' ? 'Checkbox' : 'Radio'
						file = 'choice-controls.tsx'
					}
				}
				context.report({
					node,
					messageId: 'useComponent',
					data: { component, file, tag },
				})
			},
		}
	},
}

const noRawDialogRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Render modal dialogs through <Dialog> (start/components/dialog.tsx) so focus trapping, restoration, and dismissal stay consistent.',
		},
		schema: [],
		messages: {
			useDialog:
				'Render <Dialog> from start/components/dialog.tsx instead of a raw <dialog>. See docs/contributing/ui-components.md.',
		},
	},
	createOnce(context) {
		return {
			JSXOpeningElement(node) {
				if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'dialog') {
					return
				}
				const filename = context.filename
				if (!/\/packages\/worker\/(start|client)\//.test(filename)) return
				if (/\.test\.tsx?$/.test(filename)) return
				context.report({ node, messageId: 'useDialog' })
			},
		}
	},
}

const noBareEffectRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Keep useEffect and useLayoutEffect inside start/lib/primitives.ts so effects stay rare and named.',
		},
		schema: [],
		messages: {
			useAlternative:
				'Use a route loader or useQuery for data, useSyncExternalStore for subscriptions, a ref callback with cleanup for DOM work, a key reset or render-time derivation for derived state, or an event handler for user actions. For true external sync, use a hook from start/lib/primitives.ts.',
		},
	},
	createOnce(context) {
		const effectNames = new Set(['useEffect', 'useLayoutEffect'])
		function allowed() {
			const filename = context.filename
			return (
				filename.endsWith('/start/lib/primitives.ts') ||
				/\.test\.tsx?$/.test(filename)
			)
		}
		return {
			ImportDeclaration(node) {
				if (node.source.value !== 'react' || allowed()) return
				for (const specifier of node.specifiers) {
					if (
						specifier.type === 'ImportSpecifier' &&
						effectNames.has(specifier.imported.name)
					)
						context.report({ node: specifier, messageId: 'useAlternative' })
				}
			},
			MemberExpression(node) {
				if (
					node.property.type !== 'Identifier' ||
					!effectNames.has(node.property.name) ||
					node.object.type !== 'Identifier' ||
					node.object.name !== 'React' ||
					allowed()
				)
					return
				context.report({ node, messageId: 'useAlternative' })
			},
		}
	},
}

const noRawTableRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Render data tables through <Table> (start/components/table.tsx) so cell padding, row rules, and header styling stay consistent.',
		},
		schema: [],
		messages: {
			useTable:
				'Render <Table> from start/components/table.tsx instead of a raw <table>. See docs/contributing/ui-components.md.',
		},
	},
	createOnce(context) {
		return {
			JSXOpeningElement(node) {
				if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'table') {
					return
				}
				const filename = context.filename
				if (!/\/packages\/worker\/(start|client)\//.test(filename)) return
				if (/\.test\.tsx?$/.test(filename)) return
				context.report({ node, messageId: 'useTable' })
			},
		}
	},
}

const overlayRoleOwners = {
	menu: 'menu',
	menubar: 'menu',
	menuitem: 'menu',
	menuitemcheckbox: 'menu',
	menuitemradio: 'menu',
	tooltip: 'tooltip',
	tablist: 'tabs',
	tab: 'tabs',
	tabpanel: 'tabs',
}
const overlayModuleOwners = {
	'@base-ui/react/menu': 'menu',
	'@base-ui/react/context-menu': 'menu',
	'@base-ui/react/menubar': 'menu',
	'@base-ui/react/tooltip': 'tooltip',
	'@base-ui/react/tabs': 'tabs',
}

const noRawOverlayRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Build menus, tooltips, and tabs from the shared components so keyboard support, roles, and styling stay consistent.',
		},
		schema: [],
		messages: {
			useShared:
				'Use the shared {{owner}} component from start/components/{{owner}}.tsx instead of a raw {{what}}. See docs/contributing/ui-components.md.',
		},
	},
	createOnce(context) {
		function check(node, owner, what) {
			const filename = context.filename
			if (!/\/packages\/worker\/(start|client)\//.test(filename)) return
			if (/\.test\.tsx?$/.test(filename)) return
			if (filename.endsWith(`/start/components/${owner}.tsx`)) return
			context.report({ node, messageId: 'useShared', data: { owner, what } })
		}
		return {
			ImportDeclaration(node) {
				const owner = overlayModuleOwners[node.source.value]
				if (owner) check(node, owner, `${node.source.value} import`)
			},
			JSXAttribute(node) {
				if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'role') {
					return
				}
				const value = node.value
				if (!value || value.type !== 'Literal') return
				const owner = overlayRoleOwners[value.value]
				if (owner) check(node, owner, `role="${value.value}"`)
			},
		}
	},
}

const noRawButtonStyleRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Keep buttons on the shared <Button>: no full-radius pill on clickable styles and no getButtonCss on raw button elements.',
		},
		schema: [],
		messages: {
			pillRadius:
				'Clickable controls use squircle corners: render <Button> (start/components/button.tsx) or spread getSquircleCss() instead of a full-radius pill.',
			useButton:
				'Render <Button> (start/components/button.tsx) instead of putting getButtonCss on a raw <{{tag}}>.',
		},
	},
	createOnce(context) {
		return {
			ObjectExpression(node) {
				let pill = null
				let clickable = false
				for (const property of node.properties) {
					const name = propertyName(property)
					if (name === 'borderRadius' && isPillRadius(property.value)) {
						pill = property
					}
					if (
						name === 'cursor' &&
						property.value.type === 'Literal' &&
						property.value.value === 'pointer'
					) {
						clickable = true
					}
				}
				if (pill && clickable) {
					context.report({ node: pill, messageId: 'pillRadius' })
				}
			},
			JSXOpeningElement(node) {
				if (node.name.type !== 'JSXIdentifier') return
				const tag = node.name.name
				if (!buttonLikeTags.has(tag)) return
				if (context.filename.endsWith('/start/components/button.tsx')) return
				for (const attribute of node.attributes) {
					if (
						attribute.type !== 'JSXAttribute' ||
						attribute.name.type !== 'JSXIdentifier' ||
						attribute.name.name !== 'css' ||
						attribute.value?.type !== 'JSXExpressionContainer'
					) {
						continue
					}
					if (containsButtonCssCall(attribute.value.expression)) {
						context.report({
							node: attribute,
							messageId: 'useButton',
							data: { tag },
						})
					}
				}
			},
		}
	},
}

const NON_PRODUCTION_PATH_PATTERN =
	/(?:^|\/)(?:test|tests|__tests__|test-support|e2e|fixtures|mock-servers)\/|(?:\.|-)(?:test|spec|fixture)\.[^/]+$|-test-support\.[^/]+$|(?:^|\/)vitest[^/]*\.[^/]+$|(?:^|\/)tools\/vitest-[^/]+$/
const TEST_HOOK_NAME_PATTERN = /[a-z0-9](?:ForTests?|ForTesting)$/
const TEST_RUNNER_ENV_NAMES = new Set(['VITEST', 'vitest', 'JEST_WORKER_ID'])
const TEST_MODE_ENV_NAMES = new Set(['NODE_ENV', 'MODE'])

function memberPropertyName(node) {
	if (node?.type !== 'MemberExpression') return null
	if (!node.computed && node.property.type === 'Identifier') {
		return node.property.name
	}
	if (node.computed && node.property.type === 'Literal') {
		return typeof node.property.value === 'string' ? node.property.value : null
	}
	return null
}

function isTestModeComparison(node) {
	if (!['==', '===', '!=', '!=='].includes(node.operator)) return false
	const pairs = [
		[node.left, node.right],
		[node.right, node.left],
	]
	return pairs.some(
		([member, literal]) =>
			TEST_MODE_ENV_NAMES.has(memberPropertyName(member) ?? '') &&
			literal.type === 'Literal' &&
			literal.value === 'test',
	)
}

const noTestHooksInProductionRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Keep production code identical under tests: no *ForTests helpers and no test-runner checks.',
		},
		schema: [],
		messages: {
			testHookName:
				'Keep `{{name}}` out of production code. Hold per-isolate caches in `isolateState`/`isolateCollection` from `@kody-internal/shared/isolate-state.ts` (tests call `resetIsolateState()`), inject the dependency, or move the helper to a test-support module.',
			testRunnerCheck:
				'Production code runs the same under tests. Inject the dependency (an option or env binding) or mock it from a test-support setup file instead of checking the test runner.',
		},
	},
	createOnce(context) {
		let skip = false
		function reportName(id) {
			if (skip || id?.type !== 'Identifier') return
			if (!TEST_HOOK_NAME_PATTERN.test(id.name)) return
			context.report({
				node: id,
				messageId: 'testHookName',
				data: { name: id.name },
			})
		}
		return {
			before() {
				skip = NON_PRODUCTION_PATH_PATTERN.test(
					repoRelativePath(context.filename),
				)
			},
			FunctionDeclaration(node) {
				reportName(node.id)
			},
			VariableDeclarator(node) {
				reportName(node.id)
			},
			MethodDefinition(node) {
				reportName(node.key)
			},
			PropertyDefinition(node) {
				reportName(node.key)
			},
			MemberExpression(node) {
				if (skip) return
				if (!TEST_RUNNER_ENV_NAMES.has(memberPropertyName(node) ?? '')) return
				context.report({ node, messageId: 'testRunnerCheck' })
			},
			BinaryExpression(node) {
				if (skip || !isTestModeComparison(node)) return
				context.report({ node, messageId: 'testRunnerCheck' })
			},
		}
	},
}

const EXIT_CONDITION_TOPIC_PATTERN =
	/\b(?:legacy|compat|compatibility|back(?:wards?)?[- ]compat\w*|for now|temporar(?:y|ily) (?:fix|workaround|shim|hack|path|alias|bridge|branch|copy|redirect|lane|support))\b/i
const EXIT_CONDITION_MARKER_PATTERN = /\b(?:Remove when|Permanent):[ \t]*[^\s*]/

function commentGroups(comments, sourceText) {
	const groups = []
	for (const comment of comments) {
		const previous = groups.at(-1)?.at(-1)
		const between = previous
			? sourceText.slice(previous.range[1], comment.range[0])
			: null
		const adjacent =
			previous &&
			previous.type === 'Line' &&
			comment.type === 'Line' &&
			/^[ \t]*\r?\n[ \t]*$/.test(between)
		if (adjacent) groups.at(-1).push(comment)
		else groups.push([comment])
	}
	return groups
}

const requireExitConditionCommentRule = {
	meta: {
		type: 'problem',
		docs: {
			description:
				'Comments about legacy, compatibility, or temporary paths state how the path ends.',
		},
		schema: [],
		messages: {
			missingExitCondition:
				'Say how this path ends: add `Remove when: <issue or metric>` to this comment, or `Permanent: <why>` when the behavior stays. If the condition already holds, delete the path instead.',
		},
	},
	createOnce(context) {
		return {
			Program() {
				if (
					NON_PRODUCTION_PATH_PATTERN.test(repoRelativePath(context.filename))
				) {
					return
				}
				const sourceText = context.sourceCode.getText()
				const comments = context.sourceCode.getAllComments()
				for (const group of commentGroups(comments, sourceText)) {
					const text = group
						.map((comment) => comment.value)
						.join('\n')
						.replaceAll(/`[^`\n]*`/g, '')
						.replaceAll(/\s*\n[\s*]*/g, ' ')
					if (/oxlint-disable|eslint-disable/.test(text)) continue
					if (!EXIT_CONDITION_TOPIC_PATTERN.test(text)) continue
					const raw = group
						.map((comment) => comment.value)
						.join('\n')
						.replaceAll(/\s*\n[\s*]*/g, ' ')
					if (EXIT_CONDITION_MARKER_PATTERN.test(raw)) continue
					context.report({
						loc: {
							start: context.sourceCode.getLocFromIndex(group[0].range[0]),
							end: context.sourceCode.getLocFromIndex(group.at(-1).range[1]),
						},
						messageId: 'missingExitCondition',
					})
				}
			},
		}
	},
}

const plugin = {
	meta: { name: 'kody-custom' },
	rules: {
		'enforce-import-boundaries': enforceImportBoundariesRule,
		'no-example-identifier': noExampleIdentifierRule,
		'no-floating-promise': noFloatingPromiseRule,
		'no-inline-type-only-import': noInlineTypeOnlyImportRule,
		'no-literal-frame-src': noLiteralFrameSrcRule,
		'no-nonretryable-error-name': noNonRetryableErrorNameRule,
		'no-oversized-guide-section': noOversizedGuideSectionRule,
		'no-raw-button-style': noRawButtonStyleRule,
		'no-bare-effect': noBareEffectRule,
		'no-raw-dialog': noRawDialogRule,
		'no-raw-overlay': noRawOverlayRule,
		'no-raw-table': noRawTableRule,
		'no-raw-form-control': noRawFormControlRule,
		'no-swallowed-error': noSwallowedErrorRule,
		'no-tautological-absence': noTautologicalAbsenceRule,
		'no-test-hooks-in-production': noTestHooksInProductionRule,
		'require-exit-condition-comment': requireExitConditionCommentRule,
		'require-outbound-deadline': requireOutboundDeadlineRule,
		'prefer-loader-data-types': preferLoaderDataTypesRule,
		'user-meter-budget-check-via-helper': userMeterBudgetCheckViaHelperRule,
	},
}

export default plugin
