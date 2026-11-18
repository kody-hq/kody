/** @jsxImportSource @emotion/react */
import { Badge } from '../components/badge.tsx'
import {
	emailMessageViewLabel,
	emailMessageViewValues,
	type EmailClassification,
} from '#universal/email-message-view.ts'

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
				<Badge title={classificationReason ?? 'Quarantined'} tone="danger">
					Quarantined
				</Badge>
			) : null}
			{classification === 'spam' ? (
				<Badge title={classificationReason ?? 'Spam'} tone="danger">
					Spam
				</Badge>
			) : null}
			{archivedAt ? (
				<Badge title={`Archived ${archivedAt}`}>Archived</Badge>
			) : null}
		</>
	)
}

export const emailViewOptions = emailMessageViewValues.map((view) => (
	<option key={view} value={view}>
		{emailMessageViewLabel(view)}
	</option>
))
