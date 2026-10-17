import {
	detectLegacyCredentialPatternsCodemod,
	detectLegacyCredentialPatternsCodemodId,
	type LegacyCredentialPattern,
	legacyCredentialPatternFromMessage,
} from '#worker/package-codemods/codemods/0010-detect-legacy-credential-patterns.ts'
import {
	credentialStampConversionFixGuidance,
	mergeCredentialStampIntoManifestFiles,
	scanCredentialStamp,
} from '#worker/credentials/credential-stamp.ts'
import {
	scanPackageCredentials,
	type CredentialReference,
} from '#worker/credentials/credential-inventory-scan.ts'
import {
	type PackageCredentialKind,
	type PackageCredentialSlot,
	packageCredentialKindValues,
} from '#worker/package-registry/types.ts'
import {
	readSecretMountAliases,
	secretMountsKeptCompatNote,
} from '#worker/package-runtime/secret-mount-compat.ts'
import { normalizeRepoWorkspacePath } from './manifest.ts'

const credentialPatternCheckLabel = `codemod ${detectLegacyCredentialPatternsCodemodId}`
const credentialStampGateHeading =
	'Credential stamp publish gate (issue #3836 phase 1):'
const credentialStampGateFixIntro =
	'Publish failed. Packages must be conversion-ready: every credential use is a fixed kody.credentials slot with a real description, and every call site uses a literal key. Prefer credential("SLOT") / credentials("SLOT") so callers can pick which saved credential fills each slot with the execute credentials call map ({ "SLOT": "credential-name" }) or a stored/trigger mapping; placeholders and createAuthenticatedFetch resolve the literal slot name as a saved credential name. Never choose credential names at runtime, and do not use |scope=, packageSecrets.get, server eval, vault placeholders, or credential.named() in stamped packages. Leftover kody.secretMounts may stay so stale static dependents keep resolving; removing a mount or deleting its secret breaks those dependents. Fix each item below, then publish again.'
const credentialPatternFindingsHeading = `Credential placeholder references (${credentialPatternCheckLabel}):`
const credentialPatternLabelsDoc =
	'Labels are described under "Credential slots" in the packages docs.'

/**
 * Notes for labels whose requests need a change to work as written, or where
 * a more secure option already fits. Placeholders themselves keep working
 * (ADR 0068), so no note may read as a coming removal.
 */
const credentialPatternNotes: Partial<Record<LegacyCredentialPattern, string>> =
	{
		'plain http':
			'plain http: the fetch gateway refuses a request that carries a placeholder over http://; use https:// for those requests.',
	}

type CredentialTypeHint = 'inject' | 'oauth' | 'url' | 'login' | 'signing'

/**
 * Optional suggestions, one per credential type that fits a placement the
 * scan found (ADR 0068). They describe a choice, never a problem: nothing is
 * suggested for a placement no type fits, and placeholders keep working.
 */
const credentialTypeHints: Record<CredentialTypeHint, string> = {
	inject:
		"Header, query, or basic auth placeholders: a Key with an inject (credentialUpdate) can be opened with credential(key), and its client places the value and sends it only to the Key's hosts.",
	oauth:
		'Integration token headers: credential(key) for an OAuth connection sends Authorization: Bearer and refreshes the token for you.',
	url: 'Path or whole-URL placeholders: a url credential (secretSet kind "url") holds the whole URL, and its client fetches it without the URL entering code.',
	login:
		'Password or token exchange bodies: a login credential (secretSet kind "login") runs the exchange on the host and places the session token.',
	signing:
		'Signing (secretJwtSign or signature key material): a signing credential (secretSet kind "signing") signs through credential(key).sign() without exposing the key.',
}

const credentialTypeHintsHeading =
	'Optional, if you want a scoped credential type for these (ADR 0068):'

/**
 * Whole field names only. An unanchored `pass` also matches `compass`.
 * `refresh_token` / `client_secret` stay the same names, including camelCase.
 */
const loginBodyFieldPattern =
	/^(?:pass(?:word|wd)?|refresh_?token|client_?secret)$/i

/** Codemod 0010 lists a secret name unless this slot kind is declared for it. */
const declaredSlotKindByNameKind = {
	secret: 'secret',
	integration: 'oauth',
} as const satisfies Record<CredentialReference['nameKind'], 'secret' | 'oauth'>

const packageCredentialKinds: ReadonlySet<string> = new Set(
	packageCredentialKindValues,
)

function credentialTypeHintFor(
	reference: CredentialReference,
): CredentialTypeHint | null {
	const { placement } = reference
	switch (placement.type) {
		case 'header':
			if (reference.nameKind === 'integration') {
				return placement.name === 'authorization' &&
					placement.format === 'Bearer {value}'
					? 'oauth'
					: null
			}
			return 'inject'
		case 'query':
			return reference.nameKind === 'integration' ? null : 'inject'
		case 'basic':
			return null
		case 'path':
		case 'url':
			return 'url'
		case 'body': {
			if (placement.endpoint !== 'login') return null
			const field = placement.field ?? reference.name
			return loginBodyFieldPattern.test(field) ? 'login' : null
		}
		case 'signing':
			return 'signing'
		case 'header-custom':
		case 'binding':
		case 'other':
			return null
		default: {
			const exhaustive: never = placement
			throw new Error(`Unhandled placement: ${String(exhaustive)}`)
		}
	}
}

function credentialTypeHintLines(sourceFiles: Record<string, string>) {
	let scan: ReturnType<typeof scanPackageCredentials>
	try {
		scan = scanPackageCredentials({
			files: sourceFiles,
			slots: readDeclaredCredentialSlots(sourceFiles['package.json']),
		})
	} catch {
		return []
	}
	const declaredKinds = declaredSlotKinds(scan.slots)
	const found = new Set<CredentialTypeHint>()
	for (const reference of scan.references) {
		if (referenceNamesDeclaredSlot(reference, declaredKinds)) continue
		const hint = credentialTypeHintFor(reference)
		if (hint) found.add(hint)
	}
	for (const name of scan.jwtSignSecretNames) {
		if (declaredKinds.get(name) === 'secret') continue
		found.add('signing')
		break
	}
	if (scan.jwtSignCalls > scan.jwtSignSecretNames.length) {
		found.add('signing')
	}
	const hints = (Object.keys(credentialTypeHints) as Array<CredentialTypeHint>)
		.filter((hint) => found.has(hint))
		.map((hint) => `- ${credentialTypeHints[hint]}`)
	return hints.length > 0 ? [credentialTypeHintsHeading, ...hints] : []
}

function declaredSlotKinds(
	slots: ReadonlyArray<{ name: string; kind?: PackageCredentialKind }>,
) {
	const kinds = new Map<string, PackageCredentialKind | null>()
	for (const slot of slots) {
		kinds.set(slot.name, slot.kind ?? null)
	}
	return kinds
}

function referenceNamesDeclaredSlot(
	reference: CredentialReference,
	declared: ReadonlyMap<string, PackageCredentialKind | null>,
) {
	if (!declared.has(reference.name)) return false
	const kind = declared.get(reference.name)
	if (kind == null) return true
	return kind === declaredSlotKindByNameKind[reference.nameKind]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isPackageCredentialKind(
	value: string,
): value is PackageCredentialKind {
	return packageCredentialKinds.has(value)
}

function readDeclaredCredentialSlots(
	manifestSource: string | undefined,
): Record<string, PackageCredentialSlot> | undefined {
	if (manifestSource == null) return undefined
	let parsed: unknown
	try {
		parsed = JSON.parse(manifestSource)
	} catch {
		return undefined
	}
	if (!isPlainObject(parsed) || !isPlainObject(parsed.kody)) return undefined
	const credentials = parsed.kody.credentials
	if (!isPlainObject(credentials)) return undefined
	const slots: Record<string, PackageCredentialSlot> = {}
	for (const [name, slot] of Object.entries(credentials)) {
		const declared = credentialSlotFromManifest(slot)
		if (declared) slots[name] = declared
	}
	return Object.keys(slots).length > 0 ? slots : undefined
}

function credentialSlotFromManifest(
	slot: unknown,
): PackageCredentialSlot | null {
	if (!isPlainObject(slot)) return null
	const description =
		typeof slot.description === 'string' && slot.description.trim().length > 0
			? slot.description
			: null
	if (description == null) return null
	const declared: PackageCredentialSlot = { description }
	if (typeof slot.kind === 'string') {
		if (!isPackageCredentialKind(slot.kind)) return null
		declared.kind = slot.kind
	}
	if (typeof slot.provider === 'string' && slot.provider.trim().length > 0) {
		declared.provider = slot.provider
	}
	if (typeof slot.multiple === 'boolean') declared.multiple = slot.multiple
	return declared
}

export type CredentialPatternCheckResult = {
	kind: 'credentials'
	ok: boolean
	message: string
	/** Manifest may gain auto-written stamp keys (never overwrites descriptions). */
	sourceFiles: Record<string, string>
	stampKeys: Array<string>
}

/**
 * Credential stamp publish gate: fail closed on non-literal / unstampable
 * credential patterns and on eval / new Function / non-literal import() in
 * server-runtime entry graphs. Auto-writes missing `kody.credentials` keys
 * from the stamp and fails when any stamped key lacks a description.
 */
export function buildCredentialPatternCheck(
	sourceFiles: Record<string, string>,
): CredentialPatternCheckResult {
	const preliminary = scanCredentialStamp(sourceFiles)
	const merged = mergeCredentialStampIntoManifestFiles(
		sourceFiles,
		preliminary.keys,
	)
	// Merge only rewrites package.json when it adds missing stamp keys. Reuse
	// the first scan whenever the file set is unchanged so multi-MB packages
	// do not pay for a second full AST walk inside the RepoSession DO.
	const stamp =
		merged.addedKeys.length === 0
			? preliminary
			: scanCredentialStamp(merged.files)
	const patternsByPath = new Map<string, Array<string>>()
	for (const finding of detectLegacyCredentialPatternsCodemod.detect(
		merged.files,
		{ packageName: readPackageName(merged.files) },
	)) {
		const pattern = legacyCredentialPatternFromMessage(finding.message)
		if (pattern == null) continue
		const path = finding.path ?? 'package'
		patternsByPath.set(path, [...(patternsByPath.get(path) ?? []), pattern])
	}

	const mountNote = secretMountCompatLine(merged.files)
	if (stamp.failures.length > 0) {
		const failureLines = stamp.failures.map((failure) => `- ${failure.message}`)
		const staleNote =
			stamp.staleManifestKeys.length > 0
				? [
						`Stale kody.credentials keys with no stamped use (runtime will ignore them after phase 3): ${stamp.staleManifestKeys.join(', ')}.`,
					]
				: []
		const addedNote =
			merged.addedKeys.length > 0
				? [
						`Missing kody.credentials keys (add these with a real description; publish seals them into the stamp and never overwrites a description you already wrote): ${merged.addedKeys.join(', ')}.`,
					]
				: []
		return {
			kind: 'credentials',
			ok: false,
			message: [
				credentialStampGateHeading,
				credentialStampGateFixIntro,
				...failureLines,
				...addedNote,
				...staleNote,
				...(mountNote ? [mountNote] : []),
				credentialStampConversionFixGuidance,
				...credentialTypeHintLines(merged.files),
			].join('\n'),
			sourceFiles: merged.files,
			stampKeys: stamp.keys,
		}
	}

	const staleNote =
		stamp.staleManifestKeys.length > 0
			? [
					`Stale kody.credentials keys with no stamped use: ${stamp.staleManifestKeys.join(', ')}. Remove them when you no longer need the descriptions, or keep them; runtime will allow only stamped keys after phase 3.`,
				]
			: []

	if (patternsByPath.size === 0 && stamp.keys.length === 0) {
		return {
			kind: 'credentials',
			ok: true,
			message: [
				credentialStampGateHeading,
				`Credential stamp is empty (${credentialPatternCheckLabel}): no literal credential uses to seal.`,
				...staleNote,
			]
				.filter(Boolean)
				.join('\n'),
			sourceFiles: merged.files,
			stampKeys: stamp.keys,
		}
	}

	const lines = [...patternsByPath].map(
		([path, patterns]) => `- ${path}: ${patterns.join(', ')}`,
	)
	const foundPatterns = new Set([...patternsByPath.values()].flat())
	const notes = Object.entries(credentialPatternNotes)
		.filter(([pattern]) => foundPatterns.has(pattern))
		.map(([, note]) => note)
	const stampLine =
		stamp.keys.length > 0
			? `Credential stamp keys (sorted): ${stamp.keys.join(', ')}.`
			: 'Credential stamp keys: (none).'
	return {
		kind: 'credentials',
		ok: true,
		message: [
			credentialStampGateHeading,
			stampLine,
			...(lines.length > 0
				? [
						credentialPatternFindingsHeading,
						...lines,
						`Remaining listed references are stampable literals or notes. ${credentialPatternLabelsDoc}`,
						...notes,
					]
				: []),
			...staleNote,
			...(mountNote ? [mountNote] : []),
			...credentialTypeHintLines(merged.files),
		]
			.filter((line): line is string => line != null && line.length > 0)
			.join('\n'),
		sourceFiles: merged.files,
		stampKeys: stamp.keys,
	}
}

function secretMountCompatLine(sourceFiles: Record<string, string>) {
	const aliases = readSecretMountAliases(sourceFiles['package.json'])
	if (aliases == null) return null
	return secretMountsKeptCompatNote(aliases)
}

function readPackageName(sourceFiles: Record<string, string>) {
	try {
		const name: unknown = JSON.parse(sourceFiles['package.json'] ?? '').name
		return typeof name === 'string' ? name : ''
	} catch {
		return ''
	}
}

/**
 * The findings for a published file set, or null when there are none. Repo
 * paths are scoped to `sourceRoot` the way `runRepoChecks` reads them.
 */
export function credentialPatternNoticeForFiles(
	files: Record<string, string>,
	sourceRoot = '',
) {
	const root = normalizeRepoWorkspacePath(sourceRoot).replace(/\/+$/, '')
	const scoped = root
		? Object.fromEntries(
				Object.entries(files)
					.filter(([path]) => path.startsWith(`${root}/`))
					.map(([path, content]) => [path.slice(root.length + 1), content]),
			)
		: files
	return credentialPatternFindingsNotice([buildCredentialPatternCheck(scoped)])
}

/** The credentials check message when it found something, for publish output. */
export function credentialPatternFindingsNotice(
	results: ReadonlyArray<{
		kind: string
		message: string
		ok?: boolean
	}> | null,
) {
	const check = results?.find((result) => result.kind === 'credentials')
	if (check == null) return null
	if (check.ok === false) return check.message
	return check.message.startsWith(credentialStampGateHeading) ||
		check.message.startsWith(credentialPatternFindingsHeading)
		? check.message
		: null
}
