import { createPublicKey, verify } from 'node:crypto'
import { isRecord } from '@kody-internal/shared/is-record.ts'
import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isExecutedDirectly } from '../node-runtime.ts'
import {
	type VerifiedEvidenceArtifact,
	assessCanonicalReadiness,
	canonicalEvidencePayload,
	parseSignedEvidenceEnvelope,
	renderReadinessReport,
} from './canonical-readiness.ts'
import { sha256 } from './canonical-json.ts'
import { parseBaseline, parseRestoreTrustRegistry } from './d1-restore-drill.ts'
import { parseTrustedRestoreBaselineRegistry } from './restore-trust.ts'

const uriSchemePattern = /^[a-z][a-z0-9+.-]*:/i
const trustedPublicKeysFile = fileURLToPath(
	new URL('./trusted-readiness-public-keys.json', import.meta.url),
)
const trustedD1IdentitiesFile = fileURLToPath(
	new URL('./trusted-d1-restore-identities.json', import.meta.url),
)
const trustedRestoreBaselinesFile = fileURLToPath(
	new URL('./trusted-restore-baselines.json', import.meta.url),
)

export type TrustedPublicKeyRegistry = {
	schemaVersion: 1
	keys: Array<{
		algorithm: 'Ed25519'
		keyId: string
		publicKeyPem: string
	}>
}

function exactKeys(
	value: Record<string, unknown>,
	expected: ReadonlyArray<string>,
): boolean {
	const actual = Object.keys(value).sort()
	const sortedExpected = [...expected].sort()
	return (
		actual.length === sortedExpected.length &&
		actual.every((key, index) => key === sortedExpected[index])
	)
}

export function parseTrustedPublicKeyRegistry(
	input: unknown,
): TrustedPublicKeyRegistry {
	if (
		!isRecord(input) ||
		!exactKeys(input, ['keys', 'schemaVersion']) ||
		input.schemaVersion !== 1 ||
		!Array.isArray(input.keys)
	) {
		throw new Error('trusted public-key registry has an invalid shape')
	}
	const keys: TrustedPublicKeyRegistry['keys'] = []
	const keyIds = new Set<string>()
	for (const [index, candidate] of input.keys.entries()) {
		if (
			!isRecord(candidate) ||
			!exactKeys(candidate, ['algorithm', 'keyId', 'publicKeyPem']) ||
			candidate.algorithm !== 'Ed25519' ||
			typeof candidate.keyId !== 'string' ||
			candidate.keyId.trim().length === 0 ||
			typeof candidate.publicKeyPem !== 'string' ||
			candidate.publicKeyPem.trim().length === 0
		) {
			throw new Error(
				`trusted public-key registry key[${String(index)}] is invalid`,
			)
		}
		if (keyIds.has(candidate.keyId)) {
			throw new Error(
				`trusted public-key registry has duplicate keyId ${candidate.keyId}`,
			)
		}
		const publicKey = createPublicKey(candidate.publicKeyPem)
		if (publicKey.asymmetricKeyType !== 'ed25519') {
			throw new Error(
				`trusted public-key registry key ${candidate.keyId} is not Ed25519`,
			)
		}
		keyIds.add(candidate.keyId)
		keys.push({
			algorithm: 'Ed25519',
			keyId: candidate.keyId,
			publicKeyPem: candidate.publicKeyPem,
		})
	}
	return { schemaVersion: 1, keys }
}

function resolveLocalArtifactPath(
	uri: string,
	evidenceFilePath: string,
): string {
	const evidenceDirectory = path.resolve(path.dirname(evidenceFilePath))
	let resolved: string
	const parsed = URL.parse(uri)
	if (parsed?.protocol === 'file:') {
		resolved = fileURLToPath(parsed)
	} else {
		if (uriSchemePattern.test(uri)) {
			throw new Error(`Artifact URI is not local: ${uri}`)
		}
		resolved = path.resolve(evidenceDirectory, uri)
	}
	const relative = path.relative(evidenceDirectory, resolved)
	if (
		relative === '..' ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new Error(`Artifact URI escapes the evidence directory: ${uri}`)
	}
	return resolved
}

export async function verifyLocalArtifactFiles(
	evidence: unknown,
	evidenceFilePath: string,
	trustedPublicKeys?: TrustedPublicKeyRegistry,
): Promise<ReadonlyMap<string, VerifiedEvidenceArtifact>> {
	if (!Array.isArray(evidence) || !trustedPublicKeys) return new Map()
	const artifacts: Array<{ uri: string }> = []
	for (const candidate of evidence) {
		if (!isRecord(candidate) || !Array.isArray(candidate.artifacts)) continue
		for (const artifact of candidate.artifacts) {
			if (
				isRecord(artifact) &&
				typeof artifact.uri === 'string' &&
				artifact.uri.length > 0
			) {
				artifacts.push({ uri: artifact.uri })
			}
		}
	}
	const trustedKeys = new Map(
		trustedPublicKeys.keys.map((entry) => [
			entry.keyId,
			createPublicKey(entry.publicKeyPem),
		]),
	)
	const evidenceDirectory = await realpath(
		path.resolve(path.dirname(evidenceFilePath)),
	)
	const verified = new Map<string, VerifiedEvidenceArtifact>()
	await Promise.all(
		artifacts.map(async ({ uri }) => {
			const file = resolveLocalArtifactPath(uri, evidenceFilePath)
			const canonicalFile = await realpath(file)
			const relative = path.relative(evidenceDirectory, canonicalFile)
			if (
				relative === '..' ||
				relative.startsWith(`..${path.sep}`) ||
				path.isAbsolute(relative)
			) {
				throw new Error(`Artifact URI escapes the evidence directory: ${uri}`)
			}
			const bytes = await readFile(canonicalFile)
			let parsed: unknown
			try {
				parsed = JSON.parse(bytes.toString('utf8')) as unknown
			} catch {
				return
			}
			const envelope = parseSignedEvidenceEnvelope(parsed)
			if (!envelope) return
			const trustedKey = trustedKeys.get(envelope.signature.keyId)
			if (!trustedKey) return
			const validSignature = verify(
				null,
				Buffer.from(canonicalEvidencePayload(envelope)),
				trustedKey,
				Buffer.from(envelope.signature.value, 'base64'),
			)
			if (!validSignature) return
			verified.set(uri, { digest: sha256(bytes), envelope })
		}),
	)
	return verified
}

function parseArguments(argv: ReadonlyArray<string>): { evidenceFile: string } {
	if (argv.length !== 2 || argv[0] !== '--evidence' || !argv[1]) {
		throw new Error(
			'Usage: canonical-readiness-cli.ts --evidence <evidence.json>',
		)
	}
	return { evidenceFile: argv[1] }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
	const { evidenceFile } = parseArguments(argv)
	const evidence = JSON.parse(await readFile(evidenceFile, 'utf8')) as unknown
	const trustedPublicKeys = parseTrustedPublicKeyRegistry(
		JSON.parse(await readFile(trustedPublicKeysFile, 'utf8')) as unknown,
	)
	const trustedD1Identities = parseRestoreTrustRegistry(
		JSON.parse(await readFile(trustedD1IdentitiesFile, 'utf8')) as unknown,
	)
	const trustedRestoreBaselines = parseTrustedRestoreBaselineRegistry(
		JSON.parse(await readFile(trustedRestoreBaselinesFile, 'utf8')) as unknown,
		parseBaseline,
	)
	const verifiedArtifacts = await verifyLocalArtifactFiles(
		evidence,
		evidenceFile,
		trustedPublicKeys,
	)
	const result = assessCanonicalReadiness(
		evidence,
		new Date(),
		verifiedArtifacts,
		trustedD1Identities.productionSources,
		trustedRestoreBaselines.baselines,
	)
	console.log(renderReadinessReport(result))
	if (!result.levels['full-service'].ready) process.exitCode = 1
}

if (isExecutedDirectly(import.meta.url)) {
	await main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error))
		process.exitCode = 1
	})
}
