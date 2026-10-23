import {
	AccountDeletionBillingError,
	AccountDeletionCleanupError,
	AccountDeletionInventoryError,
} from '#app/account-deletion.ts'
import { redactEmailAddresses } from '#worker/account/unverified-account-purge.ts'

export const purgeFailureDetailMaxEntries = 10
export const purgeFailureDetailMaxLength = 300

/**
 * Tokens that look like identifiers: prefixed Stripe ids (even without
 * digits), tokens carrying a digit, or a long run of id characters. Repo
 * names, source/package/storage ids, and KV keys match; ordinary English
 * words do not.
 */
const identifierLikeToken =
	/\b(?:acct|ch|cn|cs|cus|evt|ii|in|pi|pm|price|prod|re|seti|si|sub|txn)_[A-Za-z0-9]+|[A-Za-z0-9][A-Za-z0-9_:./@+-]*\d[A-Za-z0-9_:./@+-]*|[A-Za-z0-9_-]{24,}/g

/**
 * Strip ids and emails from one deletion warning so it can go to the audit log
 * and structured logs. Keeps the human-readable shape ("Artifact repo delete
 * failed for <id>: Repository not found").
 */
export function redactPurgeFailureDetail(text: string) {
	const redacted = redactEmailAddresses(text).replace(
		identifierLikeToken,
		(token) => (token.length >= 6 ? '<id>' : token),
	)
	return redacted.length > purgeFailureDetailMaxLength
		? `${redacted.slice(0, purgeFailureDetailMaxLength - 1)}…`
		: redacted
}

/**
 * The specific warnings account deletion collected before it gave up, with
 * ids stripped. Empty for errors that carry no warning list.
 */
export function purgeFailureDetails(error: unknown): Array<string> {
	const warnings =
		error instanceof AccountDeletionCleanupError
			? error.cleanupErrors
			: error instanceof AccountDeletionInventoryError
				? error.inventoryErrors
				: error instanceof AccountDeletionBillingError
					? error.billingErrors
					: []
	return Array.from(new Set(warnings.map(redactPurgeFailureDetail))).slice(
		0,
		purgeFailureDetailMaxEntries,
	)
}
