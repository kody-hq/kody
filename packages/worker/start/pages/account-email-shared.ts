import { type CSSObject } from '@emotion/react'
import { createListDetailLinks } from '#client/list-detail-route.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { type AccountEmailMessageListItem } from '#universal/loader-data.ts'
export type ClassifyState = 'idle' | 'saving'
export type DeleteState = 'idle' | 'deleting'
export type ClassificationFilter = 'all' | 'quarantined'

export const emailRoute = createListDetailLinks('/account/email')

export function senderClassificationLabel(
	classification: AccountEmailMessageListItem['sender_classification'],
) {
	switch (classification) {
		case 'member':
			return 'Member'
		case 'authenticated':
			return 'Authenticated'
		case 'unverified':
			return 'Unverified'
		case null:
			return null
		default: {
			const exhaustive: never = classification
			throw new Error(`Unhandled sender classification: ${String(exhaustive)}`)
		}
	}
}

export const senderBadgeCss = {
	display: 'inline-flex',
	alignItems: 'center',
	padding: `0.2rem ${spacing.sm}`,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	color: colors.textMuted,
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.semibold,
} as const

export const quarantinedBadgeCss: CSSObject = {
	display: 'inline-flex',
	alignItems: 'center',
	padding: `0.2rem ${spacing.sm}`,
	borderRadius: radius.md,
	border: `1px solid ${colors.danger}`,
	backgroundColor:
		'color-mix(in srgb, var(--color-danger) 10%, var(--color-surface))',
	color: colors.danger,
	fontSize: typography.fontSize.xs,
	fontWeight: typography.fontWeight.semibold,
} as const

export const truncatedTextCss: CSSObject = {
	minWidth: 0,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap',
} as const

/**
 * Subjects and addresses are arbitrary length, and a table cell will not
 * shrink below its content, so the clamp lives on a block inside the cell.
 * The subject also carries the quarantine badge: it is the one column that
 * never drops and the one that becomes the card heading, so a warning put
 * anywhere else can vanish at exactly the width where it matters most.
 */
export const subjectCellCss: CSSObject = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: spacing.xs,
	// `min()` for the same reason as `recordCellClamp`: below 620px this sits
	// in a card that can be narrower than the clamp.
	maxWidth: 'min(34ch, 100%)',
	minWidth: 0,
} as const

export function messageDate(message: AccountEmailMessageListItem) {
	return message.received_at ?? message.sent_at ?? message.created_at
}

export function statusLabel(message: AccountEmailMessageListItem) {
	if (message.delivery_status) return message.delivery_status
	return message.processing_status
}

export function directionLabel(
	direction: AccountEmailMessageListItem['direction'],
) {
	return direction === 'outbound' ? 'Outbound' : 'Inbound'
}
