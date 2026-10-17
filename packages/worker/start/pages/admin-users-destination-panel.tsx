/** @jsxImportSource @emotion/react */
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { useState, useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { adminDestinationMutationOptions } from '../admin-user-controls-query.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { mq, spacing } from '#universal/styles/tokens.ts'
import {
	fieldCss,
	fieldLabelCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
} from './account-management-components.tsx'
export function AdminUserDestinationPanel({
	stableUserId,
}: {
	stableUserId: string
}) {
	const { actorKey } = useMatchedPageScope()
	const mutation = useMutation(
		adminDestinationMutationOptions(useQueryClient()),
	)
	const capture = useSubmitterScope()
	const [email, setEmail] = useState('')
	const [message, setMessage] = useState<string | null>(null)
	const [tone, setTone] = useState<'info' | 'error'>('info')
	const busy = useRef(false)
	async function submit() {
		if (busy.current || !email.trim()) return
		busy.current = true
		setMessage(null)
		const destinationEmail = email.trim()
		const isCurrent = capture()
		try {
			await mutation.mutateAsync({
				actorKey,
				stableUserId,
				destinationEmail,
			})
			if (isCurrent()) {
				setEmail('')
				setMessage(`Marked ${destinationEmail} verified.`)
				setTone('info')
			}
		} catch (error) {
			if (isCurrent()) {
				setMessage(
					error instanceof Error
						? error.message
						: 'Unable to mark destination verified.',
				)
				setTone('error')
			}
		} finally {
			busy.current = false
		}
	}
	return (
		<AccountManagementPanel
			title="Email destination"
			description="Mark an additional destination verified after the person proves they own it (for example they mailed their inbox from it). Use when destination verification mail never arrives."
		>
			{message ? (
				<AccountManagementMessage tone={tone}>
					{message}
				</AccountManagementMessage>
			) : null}
			<div
				css={{
					display: 'grid',
					gap: spacing.md,
					gridTemplateColumns: 'minmax(0, 1fr) auto',
					alignItems: 'end',
					[mq.mobile]: { gridTemplateColumns: '1fr' },
				}}
			>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Destination email</span>
					<input
						data-field-ring
						type="email"
						disabled={mutation.isPending}
						value={email}
						aria-label="Destination email"
						placeholder="extra@example.com"
						onChange={(event) => setEmail(event.currentTarget.value)}
						css={{ width: '100%' }}
					/>
				</label>
				<button
					type="button"
					disabled={mutation.isPending || !email.trim()}
					css={getPillButtonCss({ size: 'sm' })}
					onClick={() => void submit()}
				>
					{mutation.isPending ? 'Working…' : 'Mark destination verified'}
				</button>
			</div>
		</AccountManagementPanel>
	)
}
