/**
 * Detect credentialed outbound fetch in package source so `kody dev check`
 * can suggest `.kody/mocks.ts` before `--target mock` fails closed.
 */

import {
	init as initEsModuleLexer,
	parse as parseEsModule,
} from 'es-module-lexer'

const esModuleLexerReady = initEsModuleLexer()

type CredentialedFetchKind =
	| 'createAuthenticatedFetch'
	| 'credential_runtime'
	| 'authenticatedFetch'

export type CredentialedFetchSignal = {
	kind: CredentialedFetchKind
	/** Human-readable surface label (e.g. export:./greet). */
	where: string
}

/**
 * True when source uses credentialed / authenticated outbound fetch that
 * fails closed under `--target mock` without an MSW match.
 */
export async function detectCredentialedFetchInSource(
	code: string,
	where = 'source',
): Promise<Array<CredentialedFetchSignal>> {
	await esModuleLexerReady
	const signals: Array<CredentialedFetchSignal> = []
	const seen = new Set<CredentialedFetchKind>()

	const push = (kind: CredentialedFetchKind) => {
		if (seen.has(kind)) return
		seen.add(kind)
		signals.push({ kind, where })
	}

	// Strip comments before identifier scans so JSDoc examples do not tip.
	const codeWithoutComments = stripCommentsForScan(code)
	if (/\bcreateAuthenticatedFetch\b/.test(codeWithoutComments)) {
		push('createAuthenticatedFetch')
	}
	if (/\bauthenticatedFetch\b/.test(codeWithoutComments)) {
		push('authenticatedFetch')
	}

	try {
		const [imports] = parseEsModule(code)
		for (const im of imports) {
			if (im.type === 'dynamic') {
				// Dynamic `import('kody:runtime')` does not name bindings.
				continue
			}
			if (im.typeOnly === true) continue
			if (im.specifier !== 'kody:runtime') continue
			const record = im as {
				importStart?: number
				importEnd?: number
				ss?: number
				se?: number
			}
			const statementStart = record.importStart ?? record.ss
			const statementEnd = record.importEnd ?? record.se
			if (
				typeof statementStart !== 'number' ||
				typeof statementEnd !== 'number'
			) {
				continue
			}
			const statement = code.slice(statementStart, statementEnd)
			// Named imports of credential / credentials (not default-only).
			if (/\bcredentials?\b/.test(statement)) {
				push('credential_runtime')
			}
		}
	} catch {
		// Invalid source — check still reports bundle failures separately.
	}

	return signals
}

/** Best-effort comment strip for identifier scans (not a full JS parser). */
function stripCommentsForScan(code: string): string {
	return code
		.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
		.replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function formatCredentialedFetchKinds(
	signals: ReadonlyArray<CredentialedFetchSignal>,
): string {
	const kinds = [...new Set(signals.map((s) => s.kind))]
	return kinds
		.map((kind) => {
			switch (kind) {
				case 'createAuthenticatedFetch':
					return 'createAuthenticatedFetch'
				case 'authenticatedFetch':
					return 'authenticatedFetch'
				case 'credential_runtime':
					return 'credential()/credentials()'
				default: {
					const _exhaustive: never = kind
					return _exhaustive
				}
			}
		})
		.join(', ')
}

/**
 * Soft tip for `kody dev check` when credentialed fetch is present but
 * `.kody/mocks.ts` is missing (does not fail the check).
 */
export function mocksSuggestionDetail(input: {
	signals: ReadonlyArray<CredentialedFetchSignal>
	hasMocksFile: boolean
}): string | null {
	if (input.signals.length === 0) return null
	const kinds = formatCredentialedFetchKinds(input.signals)
	if (input.hasMocksFile) {
		return `present (credentialed fetch detected: ${kinds})`
	}
	return (
		`suggested — package uses credentialed fetch (${kinds}); ` +
		`add .kody/mocks.ts so --target mock can MSW-match outbound requests ` +
		`(unmocked credentialed hops fail closed)`
	)
}
