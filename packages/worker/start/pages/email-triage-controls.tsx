/** @jsxImportSource @emotion/react */
import {
	emailMessageViewLabel,
	emailMessageViewValues,
	type EmailClassification,
} from '#universal/email-message-view.ts'
import { quarantinedBadgeCss, senderBadgeCss } from './account-email-shared.ts'

export function EmailTriageBadges({
	classification,
	classificationReason,
	archivedAt,
}: {
	classification: EmailClassification
	classificationReason: string | null
	archivedAt: string | null
}) {
	return (
		<>
			{classification === 'quarantined' ? (
				<span
					title={classificationReason ?? 'Quarantined'}
					css={quarantinedBadgeCss}
				>
					Quarantined
				</span>
			) : null}
			{classification === 'spam' ? (
				<span title={classificationReason ?? 'Spam'} css={quarantinedBadgeCss}>
					Spam
				</span>
			) : null}
			{archivedAt ? (
				<span title={`Archived ${archivedAt}`} css={senderBadgeCss}>
					Archived
				</span>
			) : null}
		</>
	)
}

export const emailViewOptions = emailMessageViewValues.map((view) => (
	<option key={view} value={view}>
		{emailMessageViewLabel(view)}
	</option>
))
