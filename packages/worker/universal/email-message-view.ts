export const emailClassificationValues = [
	'accepted',
	'quarantined',
	'spam',
] as const
export type EmailClassification = (typeof emailClassificationValues)[number]

/**
 * Message list views. `inbox` (the default) hides spam and archived mail;
 * `inbox`, `archived`, and `spam` partition every message. `accepted` and
 * `quarantined` narrow `inbox`.
 */
export const emailMessageViewValues = [
	'inbox',
	'accepted',
	'quarantined',
	'spam',
	'archived',
	'all',
] as const
export type EmailMessageView = (typeof emailMessageViewValues)[number]
export const defaultEmailMessageView: EmailMessageView = 'inbox'

export function isEmailMessageView(value: unknown): value is EmailMessageView {
	return (
		typeof value === 'string' &&
		(emailMessageViewValues as ReadonlyArray<string>).includes(value)
	)
}

/** Client mirror of `emailMessageViewSqlClauses` for optimistic list edits. */
export function emailMessageMatchesView(
	view: EmailMessageView,
	message: { classification: EmailClassification; archived_at: string | null },
): boolean {
	const archived = message.archived_at !== null
	switch (view) {
		case 'inbox':
			return message.classification !== 'spam' && !archived
		case 'accepted':
		case 'quarantined':
			return message.classification === view && !archived
		case 'spam':
			return message.classification === 'spam'
		case 'archived':
			return message.classification !== 'spam' && archived
		case 'all':
			return true
		default: {
			const exhaustive: never = view
			throw new Error(`Unhandled email message view: ${String(exhaustive)}`)
		}
	}
}

/** Manual reclassification reasons; receive-time reasons come from policy. */
export function manualEmailClassificationReason(
	classification: EmailClassification,
): string | null {
	switch (classification) {
		case 'accepted':
			return null
		case 'quarantined':
			return 'Reclassified by user.'
		case 'spam':
			return 'Marked as spam.'
		default: {
			const exhaustive: never = classification
			throw new Error(`Unhandled email classification: ${String(exhaustive)}`)
		}
	}
}

export function emailMessageViewLabel(view: EmailMessageView): string {
	switch (view) {
		case 'inbox':
			return 'Inbox'
		case 'accepted':
			return 'Accepted'
		case 'quarantined':
			return 'Quarantined'
		case 'spam':
			return 'Spam'
		case 'archived':
			return 'Archived'
		case 'all':
			return 'All mail'
		default: {
			const exhaustive: never = view
			throw new Error(`Unhandled email message view: ${String(exhaustive)}`)
		}
	}
}

/**
 * Pre-view URLs used `?classification=quarantined`; keep those links working.
 * Anything else falls back to the default inbox view.
 */
export function readEmailMessageViewParam(
	params: URLSearchParams,
): EmailMessageView {
	const view = params.get('view')?.trim()
	if (isEmailMessageView(view)) return view
	const legacy = params.get('classification')?.trim()
	if (legacy === 'quarantined' || legacy === 'spam') return legacy
	return defaultEmailMessageView
}
