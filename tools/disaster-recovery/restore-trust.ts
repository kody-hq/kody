import { createPublicKey, verify } from 'node:crypto'

import {
	canonicalBackupManifestPayload,
	parseBackupManifest,
	type BackupManifest,
} from '@kody-internal/shared/backup-manifest.ts'
import { isRecord } from '@kody-internal/shared/is-record.ts'

import { canonicalJson, sha256 } from './canonical-json.ts'
import type {
	RestoreBaseline,
	RestoreTrustRegistry,
} from './d1-restore-drill.ts'

const sha256Pattern = /^[0-9a-f]{64}$/
const keyIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const base64Pattern =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const cloudflareAccountIdPattern = /^[0-9a-f]{32}$/
const uuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

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

export type TrustedManifestPublicKeyRegistry = {
	schemaVersion: 1
	keys: Array<{
		algorithm: 'Ed25519'
		keyId: string
		publicKeyPem: string
	}>
}

export type TrustedRestoreBaselineRegistry = {
	schemaVersion: 1
	baselines: Array<{
		id: string
		canonicalSha256: string
		source: {
			accountId: string
			databaseId: string
			databaseName: string
		}
		baseline: RestoreBaseline
	}>
}

export function parseTrustedManifestPublicKeyRegistry(
	value: unknown,
): TrustedManifestPublicKeyRegistry {
	if (
		!isRecord(value) ||
		!exactKeys(value, ['keys', 'schemaVersion']) ||
		value.schemaVersion !== 1 ||
		!Array.isArray(value.keys)
	) {
		throw new Error('trusted manifest public-key registry has an invalid shape')
	}
	const keys: TrustedManifestPublicKeyRegistry['keys'] = []
	const ids = new Set<string>()
	for (const candidate of value.keys) {
		if (
			!isRecord(candidate) ||
			!exactKeys(candidate, ['algorithm', 'keyId', 'publicKeyPem']) ||
			candidate.algorithm !== 'Ed25519' ||
			typeof candidate.keyId !== 'string' ||
			!keyIdPattern.test(candidate.keyId) ||
			typeof candidate.publicKeyPem !== 'string' ||
			candidate.publicKeyPem.length === 0 ||
			ids.has(candidate.keyId)
		) {
			throw new Error('trusted manifest public-key registry has an invalid key')
		}
		const key = createPublicKey(candidate.publicKeyPem)
		if (key.asymmetricKeyType !== 'ed25519') {
			throw new Error('trusted manifest public key is not Ed25519')
		}
		ids.add(candidate.keyId)
		keys.push({
			algorithm: 'Ed25519',
			keyId: candidate.keyId,
			publicKeyPem: candidate.publicKeyPem,
		})
	}
	return { schemaVersion: 1, keys }
}

export function verifyTrustedBackupManifest(
	manifestBytes: Uint8Array,
	expectedManifestSha256: string,
	registryValue: unknown,
): Readonly<BackupManifest> {
	if (!sha256Pattern.test(expectedManifestSha256)) {
		throw new Error('expected manifest SHA-256 must be a lowercase digest')
	}
	if (sha256(manifestBytes) !== expectedManifestSha256) {
		throw new Error('downloaded manifest bytes do not match expected SHA-256')
	}
	let parsedJson: unknown
	try {
		parsedJson = JSON.parse(
			new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes),
		) as unknown
	} catch {
		throw new Error('downloaded manifest is not valid UTF-8 JSON')
	}
	const manifest = parseBackupManifest(parsedJson)
	const registry = parseTrustedManifestPublicKeyRegistry(registryValue)
	const trusted = registry.keys.find(
		(candidate) =>
			candidate.keyId === manifest.signature.keyId &&
			candidate.algorithm === manifest.signature.algorithm,
	)
	if (!trusted) {
		throw new Error('manifest signing key is not trusted')
	}
	if (!base64Pattern.test(manifest.signature.value)) {
		throw new Error('manifest signature is not canonical base64')
	}
	const signature = Buffer.from(manifest.signature.value, 'base64')
	if (
		signature.byteLength !== 64 ||
		!verify(
			null,
			Buffer.from(canonicalBackupManifestPayload(manifest.payload)),
			createPublicKey(trusted.publicKeyPem),
			signature,
		)
	) {
		throw new Error('manifest signature verification failed')
	}
	return Object.freeze(manifest)
}

export function parseTrustedRestoreBaselineRegistry(
	value: unknown,
	parseBaseline: (value: unknown, label?: string) => Readonly<RestoreBaseline>,
): TrustedRestoreBaselineRegistry {
	if (
		!isRecord(value) ||
		!exactKeys(value, ['baselines', 'schemaVersion']) ||
		value.schemaVersion !== 1 ||
		!Array.isArray(value.baselines)
	) {
		throw new Error('trusted restore-baseline registry has an invalid shape')
	}
	const ids = new Set<string>()
	const baselines = value.baselines.map((candidate, index) => {
		if (
			!isRecord(candidate) ||
			!exactKeys(candidate, ['baseline', 'canonicalSha256', 'id', 'source']) ||
			typeof candidate.id !== 'string' ||
			!keyIdPattern.test(candidate.id) ||
			typeof candidate.canonicalSha256 !== 'string' ||
			!sha256Pattern.test(candidate.canonicalSha256) ||
			!isRecord(candidate.source) ||
			!exactKeys(candidate.source, [
				'accountId',
				'databaseId',
				'databaseName',
			]) ||
			typeof candidate.source.accountId !== 'string' ||
			!cloudflareAccountIdPattern.test(candidate.source.accountId) ||
			typeof candidate.source.databaseId !== 'string' ||
			!uuidPattern.test(candidate.source.databaseId) ||
			typeof candidate.source.databaseName !== 'string' ||
			candidate.source.databaseName.length === 0 ||
			ids.has(candidate.id)
		) {
			throw new Error('trusted restore-baseline registry has an invalid entry')
		}
		const baseline = parseBaseline(
			candidate.baseline,
			`trusted baseline[${String(index)}]`,
		)
		if (sha256(canonicalJson(baseline)) !== candidate.canonicalSha256) {
			throw new Error('trusted restore baseline canonical digest is invalid')
		}
		ids.add(candidate.id)
		return {
			id: candidate.id,
			canonicalSha256: candidate.canonicalSha256,
			source: {
				accountId: candidate.source.accountId,
				databaseId: candidate.source.databaseId,
				databaseName: candidate.source.databaseName,
			},
			baseline: baseline as RestoreBaseline,
		}
	})
	return { schemaVersion: 1, baselines }
}

export function resolveTrustedRestoreBaseline(input: {
	id: string
	manifest: Readonly<BackupManifest>
	registryValue: unknown
	restoreTrustRegistry: Readonly<RestoreTrustRegistry>
	parseBaseline: (value: unknown, label?: string) => Readonly<RestoreBaseline>
	requireManifestDigest: boolean
}): Readonly<RestoreBaseline> {
	const registry = parseTrustedRestoreBaselineRegistry(
		input.registryValue,
		input.parseBaseline,
	)
	const selected = registry.baselines.find((entry) => entry.id === input.id)
	if (!selected) throw new Error('restore baseline id is not trusted')
	const source = input.manifest.payload.source
	if (
		selected.source.accountId.toLowerCase() !==
			source.accountId.toLowerCase() ||
		selected.source.databaseId.toLowerCase() !==
			source.databaseId.toLowerCase() ||
		selected.source.databaseName !== source.databaseName ||
		selected.baseline.sourceDatabaseId.toLowerCase() !==
			source.databaseId.toLowerCase()
	) {
		throw new Error('trusted restore baseline source does not match manifest')
	}
	if (
		!input.restoreTrustRegistry.productionSources.some(
			(candidate) =>
				candidate.accountId.toLowerCase() ===
					selected.source.accountId.toLowerCase() &&
				candidate.databaseId.toLowerCase() ===
					selected.source.databaseId.toLowerCase() &&
				candidate.databaseName === selected.source.databaseName,
		)
	) {
		throw new Error(
			'trusted restore baseline source is not a production source',
		)
	}
	if (
		input.requireManifestDigest &&
		(input.manifest.payload.restoreBaseline.id !== selected.id ||
			input.manifest.payload.restoreBaseline.sha256 !==
				selected.canonicalSha256)
	) {
		throw new Error('signed manifest restore baseline digest does not match')
	}
	return selected.baseline
}
