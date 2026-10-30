/**
 * Warn-only publish check that a package declares the Kody capabilities its
 * own modules call (ADR 0089). Publish and `kody dev check` both run it through
 * `runRepoChecks`. It never fails a check until the rollout switch flips.
 * With a package loader it also walks the static import closure.
 */
import {
	listScannableModulePaths,
	parseModule,
} from '#worker/credentials/module-placeholder-scan.ts'
import {
	collectModuleKodyCalls,
	needsCapabilityDeclaration,
} from '#worker/package-codemods/codemods/0017-detect-package-app-visitor-authority.ts'
import {
	type ClosurePackageLoader,
	scanPackageAppImportClosure,
} from '#worker/package-codemods/package-app-capability-closure.ts'
import { type AuthoredPackageJson } from '#worker/package-registry/types.ts'
import { declaredCapabilitiesOf } from '#worker/package-runtime/package-app-effective-capabilities.ts'

type CapabilityDeclarationFinding =
	| { kind: 'undeclared'; path: string; names: Array<string> }
	| { kind: 'unverifiable'; path: string; calls: number }
	| { kind: 'closure-undeclared'; names: Array<string> }
	| { kind: 'closure-unverifiable'; calls: number }
	| { kind: 'closure-unresolved'; imports: number }
	| { kind: 'closure-timeout' }

/** Publish waits at most this long for the closure walk; it never blocks. */
const closureBudgetMs = 5_000

/** `kody.capabilities` plus, for an app, `kody.app.capabilities`. */
export function declaredPackageCapabilities(
	manifest: Pick<AuthoredPackageJson, 'kody'>,
) {
	// Package-app authority checks only `kody.app.capabilities`, so an app's
	// own calls count as declared only there.
	return new Set(declaredCapabilitiesOf(manifest))
}

export function findCapabilityDeclarationGaps(input: {
	manifest: Pick<AuthoredPackageJson, 'kody'>
	sourceFiles: Record<string, string>
}): Array<CapabilityDeclarationFinding> {
	const declared = declaredPackageCapabilities(input.manifest)
	const findings: Array<CapabilityDeclarationFinding> = []
	for (const path of listScannableModulePaths(input.sourceFiles).sort()) {
		const source = input.sourceFiles[path]
		if (typeof source !== 'string') continue
		const parsed = parseModule(source)
		if (!parsed) continue
		const calls = collectModuleKodyCalls(parsed)
		const undeclared = [...calls.names]
			.filter((name) => needsCapabilityDeclaration(name) && !declared.has(name))
			.sort()
		if (undeclared.length > 0) {
			findings.push({ kind: 'undeclared', path, names: undeclared })
		}
		// A name picked at run time is covered once the package declares
		// something: the runtime still caps it to that list.
		const unverifiable = calls.computedCalls + calls.mcpCalls
		if (unverifiable > 0 && declared.size === 0) {
			findings.push({ kind: 'unverifiable', path, calls: unverifiable })
		}
	}
	return findings
}

/**
 * The package's effective capabilities: its own declaration plus the
 * declarations of every package its static imports reach (ADR 0089), and the
 * closure calls that set does not cover. The runtime still caps an app to
 * `kody.app.capabilities` alone, so for an app imported needs count only once
 * that list holds them.
 */
export async function computeCapabilityClosure(input: {
	manifest: Pick<AuthoredPackageJson, 'kody' | 'name'>
	sourceFiles: Record<string, string>
	loadPackage: ClosurePackageLoader
}) {
	const selfId = `self:${input.manifest.name}`
	const own = declaredPackageCapabilities(input.manifest)
	const imported = new Set<string>()
	const closure = await scanPackageAppImportClosure({
		appPackageId: selfId,
		appFiles: input.sourceFiles,
		loadPackage: async (packageName) => {
			if (packageName === input.manifest.name) {
				return {
					id: selfId,
					files: {},
					manifest: input.manifest as AuthoredPackageJson,
				}
			}
			const loaded = await input.loadPackage(packageName)
			if (loaded) {
				for (const name of declaredPackageCapabilities(loaded.manifest)) {
					imported.add(name)
				}
			}
			return loaded
		},
	})
	const effective = new Set([...own, ...imported])
	const covering = input.manifest.kody.app ? own : effective
	const needed = new Set([
		...closure.names.filter(needsCapabilityDeclaration),
		...(input.manifest.kody.app ? imported : []),
	])
	return {
		effective: [...effective].sort(),
		uncovered: [...needed].filter((name) => !covering.has(name)).sort(),
		unverifiable:
			covering.size === 0 ? closure.computedCalls + closure.mcpCalls : 0,
		unresolvedImports: closure.unresolvedImports,
	}
}

async function findClosureGaps(input: {
	manifest: Pick<AuthoredPackageJson, 'kody' | 'name'>
	sourceFiles: Record<string, string>
	loadPackage: ClosurePackageLoader
}): Promise<Array<CapabilityDeclarationFinding>> {
	const closure = await computeCapabilityClosure(input)
	const findings: Array<CapabilityDeclarationFinding> = []
	if (closure.uncovered.length > 0) {
		findings.push({ kind: 'closure-undeclared', names: closure.uncovered })
	}
	if (closure.unverifiable > 0) {
		findings.push({ kind: 'closure-unverifiable', calls: closure.unverifiable })
	}
	if (closure.unresolvedImports > 0) {
		findings.push({
			kind: 'closure-unresolved',
			imports: closure.unresolvedImports,
		})
	}
	return findings
}

function formatFinding(finding: CapabilityDeclarationFinding) {
	if (finding.kind === 'undeclared') {
		const names = finding.names.map((name) => `\`${name}\``).join(', ')
		return `- \`${finding.path}\` calls ${names}, which the package does not declare.`
	}
	if (finding.kind === 'closure-undeclared') {
		const names = finding.names.map((name) => `\`${name}\``).join(', ')
		return `- Imported packages call ${names}, which this package's declaration does not cover.`
	}
	if (finding.kind === 'closure-unverifiable') {
		return `- Imported packages pick ${finding.calls} capability name(s) at run time, and this package declares no capabilities that could cover them.`
	}
	if (finding.kind === 'closure-unresolved') {
		return `- ${finding.imports} import(s) of other packages could not be resolved statically, so the capabilities they need were not checked.`
	}
	if (finding.kind === 'closure-timeout') {
		return '- Imported packages were not checked: walking the import closure took too long.'
	}
	return `- \`${finding.path}\` picks ${finding.calls} capability name(s) at run time (a computed \`kody[...]\` call or \`kody.mcp\`), and the package declares no capabilities that could cover them.`
}

export async function buildCapabilityDeclarationCheck(input: {
	manifest: Pick<AuthoredPackageJson, 'kody' | 'name'>
	sourceFiles: Record<string, string>
	/** Without one (offline checks) only the package's own modules are read. */
	loadPackage?: ClosurePackageLoader
	closureBudgetMs?: number
}) {
	const findings = findCapabilityDeclarationGaps(input)
	if (input.loadPackage) {
		const budgetMs = input.closureBudgetMs ?? closureBudgetMs
		const deadline = Date.now() + budgetMs
		const loadPackage = input.loadPackage
		let overBudget = false
		// Past the deadline, stop loading packages; a failed load counts as an
		// unresolved import instead of discarding what was already found.
		const boundedLoader: ClosurePackageLoader = async (packageName) => {
			if (overBudget || Date.now() > deadline) {
				overBudget = true
				return null
			}
			try {
				return await loadPackage(packageName)
			} catch {
				return null
			}
		}
		let timer: ReturnType<typeof setTimeout> | undefined
		const timedOut = new Promise<'timeout'>((resolve) => {
			timer = setTimeout(() => {
				overBudget = true
				resolve('timeout')
			}, budgetMs)
		})
		try {
			const closure = await Promise.race([
				findClosureGaps({ ...input, loadPackage: boundedLoader }),
				timedOut,
			])
			if (closure !== 'timeout') findings.push(...closure)
			if (closure === 'timeout' || overBudget) {
				findings.push({ kind: 'closure-timeout' })
			}
		} catch {
			findings.push({ kind: 'closure-unresolved', imports: 1 })
		} finally {
			clearTimeout(timer)
		}
	}
	if (findings.length === 0) return null
	const list = input.manifest.kody.app
		? '`kody.app.capabilities`'
		: '`kody.capabilities`'
	return {
		kind: 'capabilities' as const,
		ok: true,
		message: [
			'Warning (does not fail publish yet): capability declarations are incomplete.',
			...findings.map(formatFinding),
			`Add each capability these modules and their imports call to ${list}. Apps that import this package will need them, and publish will start failing on these once the rollout switch flips (ADR 0089).`,
		].join('\n'),
	}
}
