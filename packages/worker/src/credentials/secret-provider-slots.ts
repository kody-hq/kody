/**
 * Resolves `kind: "secret-provider"` slots for the publish stamp gate: each
 * slot names a saved provider package, and the gate seals vault placeholders
 * whose literal provider id equals that package's `kody.secretProvider.id`.
 */
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { getSavedPackageByName } from '#worker/package-registry/repo.ts'
import {
	secretProviderSlotKind,
	secretProviderSlotPackagePattern,
} from '#worker/package-registry/types.ts'
import { loadPublishedEntityManifest } from '#worker/repo/published-source.ts'

export type SecretProviderSlotFailure = {
	code: 'unstampable_pattern'
	message: string
}

/** Provider ids by slot key, plus why any slot did not resolve. */
export type ResolvedSecretProviderSlots = {
	ids: Record<string, string>
	failures: Array<SecretProviderSlotFailure>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

/** Described secret-provider slots in a package.json, by key. */
export function readSecretProviderSlotPackages(
	manifestSource: string | undefined,
): Record<string, string> {
	if (manifestSource == null) return {}
	let parsed: unknown
	try {
		parsed = JSON.parse(manifestSource)
	} catch {
		return {}
	}
	if (!isPlainObject(parsed) || !isPlainObject(parsed.kody)) return {}
	const credentials = parsed.kody.credentials
	if (!isPlainObject(credentials)) return {}
	const packages: Record<string, string> = {}
	for (const [key, slot] of Object.entries(credentials)) {
		if (!isPlainObject(slot) || slot.kind !== secretProviderSlotKind) continue
		if (typeof slot.description !== 'string' || !slot.description.trim()) {
			continue
		}
		if (typeof slot.package !== 'string') continue
		packages[key] = slot.package.trim()
	}
	return packages
}

/**
 * Looks up each secret-provider slot's package in the publishing org and
 * reads its `kody.secretProvider.id`. A missing, unreadable, or id-less
 * package is a publish failure; its slot seals nothing.
 */
export async function resolveSecretProviderSlots(input: {
	env: Env
	/** The org that is publishing. */
	userId: string
	files: Record<string, string>
}): Promise<ResolvedSecretProviderSlots> {
	const packages = readSecretProviderSlotPackages(input.files['package.json'])
	const resolved: ResolvedSecretProviderSlots = { ids: {}, failures: [] }
	for (const [key, packageName] of Object.entries(packages)) {
		const fail = (reason: string) =>
			resolved.failures.push({
				code: 'unstampable_pattern',
				message: `kody.credentials.${key} names provider package "${packageName}", which ${reason}. A kind "secret-provider" slot must name a saved package in this org whose package.json declares kody.secretProvider.id.`,
			})
		if (!secretProviderSlotPackagePattern.test(packageName)) {
			fail('is not a scoped package name')
			continue
		}
		try {
			const saved = await getSavedPackageByName(input.env.APP_DB, {
				userId: input.userId,
				name: packageName,
			})
			if (!saved) {
				fail('is not a saved package in this org')
				continue
			}
			const { manifest } = await loadPublishedEntityManifest({
				env: input.env,
				userId: saved.userId,
				sourceId: saved.sourceId,
			})
			const providerId = manifest.kody.secretProvider?.id?.trim().toLowerCase()
			if (!providerId) {
				fail('does not declare kody.secretProvider.id')
				continue
			}
			resolved.ids[key] = providerId
		} catch (error) {
			fail(`could not be read (${getErrorMessage(error)})`)
		}
	}
	return resolved
}
