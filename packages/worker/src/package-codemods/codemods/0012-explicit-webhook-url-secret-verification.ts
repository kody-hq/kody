import type {
	PackageCodemod,
	PackageCodemodFinding,
	PackageCodemodTransformResult,
} from '../types.ts'

export const explicitWebhookUrlSecretVerificationCodemodId =
	'0012-explicit-webhook-url-secret-verification'

const packageManifestPath = 'package.json'

const undeclaredVerificationMessage =
	'Declares a kody.webhooks entry without verification. It keeps working on its URL secret; consider declaring verification: { "type": "url-secret" } (same behavior, explicit), or an HMAC type if the sender signs.'

const invalidJsonMessage =
	'package.json is missing or not valid JSON; review kody.webhooks manually.'

const invalidShapeMessage =
	'package.json#kody.webhooks is not an array of objects, or a webhook verification is not an object; review and update manually.'

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

function parseManifest(source: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(source)
		return isPlainObject(parsed) ? parsed : null
	} catch {
		return null
	}
}

function detectExplicitWebhookUrlSecretVerification(
	files: Record<string, string>,
): Array<PackageCodemodFinding> {
	const source = files[packageManifestPath]
	if (typeof source !== 'string') {
		return [{ path: packageManifestPath, message: invalidJsonMessage }]
	}
	const parsed = parseManifest(source)
	if (!parsed) {
		return [{ path: packageManifestPath, message: invalidJsonMessage }]
	}
	const kody = parsed['kody']
	if (kody === undefined) return []
	if (!isPlainObject(kody)) {
		return [{ path: packageManifestPath, message: invalidShapeMessage }]
	}
	const webhooks = kody['webhooks']
	if (webhooks === undefined) return []
	if (!Array.isArray(webhooks) || !webhooks.every(isPlainObject)) {
		return [{ path: packageManifestPath, message: invalidShapeMessage }]
	}
	let undeclared = false
	for (const webhook of webhooks) {
		if (!('verification' in webhook)) {
			undeclared = true
		} else if (!isPlainObject(webhook['verification'])) {
			return [{ path: packageManifestPath, message: invalidShapeMessage }]
		}
	}
	return undeclared
		? [{ path: packageManifestPath, message: undeclaredVerificationMessage }]
		: []
}

function transformExplicitWebhookUrlSecretVerification(
	files: Record<string, string>,
): PackageCodemodTransformResult {
	return {
		files: { ...files },
		changed: false,
		changedPaths: [],
		needsManual: detectExplicitWebhookUrlSecretVerification(files),
	}
}

/**
 * Detect-only: lists `kody.webhooks` entries with no `verification`. Omitting
 * `verification` is a supported, permanent state (URL secret only), so this
 * never rewrites manifests; owners choose whether to declare a type.
 * https://github.com/kody-hq/kody/issues/3477
 */
export const explicitWebhookUrlSecretVerificationCodemod = {
	id: explicitWebhookUrlSecretVerificationCodemodId,
	description:
		'Detect-only: list package.json#kody.webhooks entries that declare no verification (they keep running on the URL secret) so owners can choose to declare one.',
	// Earlier apply runs used the published-only lane; revert of those runs
	// must take the same lane.
	applyMode: 'published-only',
	detect: detectExplicitWebhookUrlSecretVerification,
	transform: transformExplicitWebhookUrlSecretVerification,
} satisfies PackageCodemod
