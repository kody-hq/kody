/**
 * Warn-only publish check that a package declares the Kody capabilities its
 * own modules call (ADR 0089). Publish and `kody dev check` both run it through
 * `runRepoChecks`. It never fails a check until the rollout switch flips.
 */
import {
	listScannableModulePaths,
	parseModule,
} from '#worker/credentials/module-placeholder-scan.ts'
import {
	collectModuleKodyCalls,
	needsCapabilityDeclaration,
} from '#worker/package-codemods/codemods/0017-detect-package-app-visitor-authority.ts'
import { type AuthoredPackageJson } from '#worker/package-registry/types.ts'

type CapabilityDeclarationFinding =
	| { kind: 'undeclared'; path: string; names: Array<string> }
	| { kind: 'unverifiable'; path: string; calls: number }

/** `kody.capabilities` plus, for an app, `kody.app.capabilities`. */
export function declaredPackageCapabilities(
	manifest: Pick<AuthoredPackageJson, 'kody'>,
) {
	// Package-app authority checks only `kody.app.capabilities`, so an app's
	// own calls count as declared only there.
	const app = manifest.kody.app
	return new Set(
		app ? (app.capabilities ?? []) : (manifest.kody.capabilities ?? []),
	)
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

function formatFinding(finding: CapabilityDeclarationFinding) {
	if (finding.kind === 'undeclared') {
		const names = finding.names.map((name) => `\`${name}\``).join(', ')
		return `- \`${finding.path}\` calls ${names}, which the package does not declare.`
	}
	return `- \`${finding.path}\` picks ${finding.calls} capability name(s) at run time (a computed \`kody[...]\` call or \`kody.mcp\`), and the package declares no capabilities that could cover them.`
}

export function buildCapabilityDeclarationCheck(input: {
	manifest: Pick<AuthoredPackageJson, 'kody'>
	sourceFiles: Record<string, string>
}) {
	const findings = findCapabilityDeclarationGaps(input)
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
			`Add each capability these modules call to ${list}. Apps that import this package will need them, and publish will start failing on these once the rollout switch flips (ADR 0089).`,
		].join('\n'),
	}
}
