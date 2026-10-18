/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { type FormEvent } from 'react'
import { type EmailNotificationDestination } from '#universal/email-destinations.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	AccountManagementPanel,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
	verifiedPillCss,
} from './account-management-components.tsx'

export type AccountEmailDestinationsPanelProps = {
	destinations: Array<EmailNotificationDestination>
	additionalRemaining: number
	additionalLimit: number
	draftEmail: string
	status: 'idle' | 'sending'
	message: string | null
	tone: 'error' | 'info'
	pendingId: string | null
	onDraftEmailInput: (event: FormEvent<HTMLInputElement>) => void
	onAddSubmit: (event: FormEvent<HTMLFormElement>) => void
	onResend: (id: string) => void
	onSetDefault: (id: string) => void
	onRemove: (id: string) => void
}

export function renderAccountEmailDestinationsPanel(
	props: AccountEmailDestinationsPanelProps,
) {
	const {
		destinations,
		additionalRemaining,
		additionalLimit,
		draftEmail,
		status,
		message,
		tone,
		pendingId,
		onDraftEmailInput,
		onAddSubmit,
		onResend,
		onSetDefault,
		onRemove,
	} = props
	const compactGhostButtonCss = getGhostButtonCss({ size: 'sm' })
	const compactPillButtonCss = getPillButtonCss({ size: 'sm' })
	const isSending = status === 'sending'

	return (
		<AccountManagementPanel
			id="email-destinations"
			title="Email destinations"
			description="Addresses emailSend may use. Mail comes from your Kody platform address. The account email is always available. Extra addresses need a verification link first."
		>
			<ul
				css={{
					listStyle: 'none',
					margin: 0,
					padding: 0,
					display: 'grid',
					gap: spacing.md,
				}}
			>
				{destinations.map((destination) => (
					<li
						key={destination.id}
						css={{
							display: 'grid',
							gap: spacing.sm,
						}}
					>
						<div
							css={{
								display: 'flex',
								flexWrap: 'wrap',
								alignItems: 'center',
								gap: spacing.sm,
							}}
						>
							<p css={{ margin: 0 }}>{destination.email}</p>
							{destination.kind === 'identity' ? (
								<span css={badgeCss}>Account email</span>
							) : null}
							{destination.isDefault ? (
								<span css={badgeCss}>Default</span>
							) : null}
							{destination.verified ? (
								<span css={verifiedPillCss}>Verified</span>
							) : (
								<span css={pendingBadgeCss}>Unverified</span>
							)}
						</div>
						<div
							css={{
								display: 'flex',
								flexWrap: 'wrap',
								gap: spacing.sm,
							}}
						>
							{destination.verified && !destination.isDefault ? (
								<button
									type="button"
									disabled={isSending}
									onClick={() => {
										onSetDefault(destination.id)
									}}
									css={compactPillButtonCss}
								>
									{pendingId === destination.id && isSending
										? 'Saving…'
										: 'Set as default'}
								</button>
							) : null}
							{!destination.verified && destination.kind === 'additional' ? (
								<button
									type="button"
									disabled={isSending}
									onClick={() => {
										onResend(destination.id)
									}}
									css={compactGhostButtonCss}
								>
									{pendingId === destination.id && isSending
										? 'Sending…'
										: 'Resend verification'}
								</button>
							) : null}
							{destination.canRemove ? (
								<button
									type="button"
									disabled={isSending}
									onClick={() => {
										onRemove(destination.id)
									}}
									css={compactGhostButtonCss}
								>
									{pendingId === destination.id && isSending
										? 'Removing…'
										: 'Remove'}
								</button>
							) : null}
						</div>
					</li>
				))}
			</ul>
			{additionalRemaining > 0 ? (
				<form
					method="post"
					onSubmit={onAddSubmit}
					css={{
						display: 'grid',
						gap: spacing.md,
					}}
				>
					<label css={accountFieldCss}>
						<span css={accountFieldLabelCss}>Add an address</span>
						<input
							type="email"
							name="email"
							autoComplete="email"
							value={draftEmail}
							disabled={isSending}
							onInput={onDraftEmailInput}
							css={accountInputCss}
						/>
						<span css={accountFieldNoteCss}>
							Up to {additionalLimit} extras besides your account email. We send
							a verification link before emailSend can use this address. New
							accounts can request that link 24 hours after signup.
						</span>
					</label>
					<button
						type="submit"
						disabled={isSending || draftEmail.trim().length === 0}
						css={getPillButtonCss()}
					>
						{isSending && pendingId === null
							? 'Sending…'
							: 'Send verification link'}
					</button>
				</form>
			) : (
				<p css={accountFieldNoteCss}>
					You have reached the {additionalLimit} extra-address limit.
				</p>
			)}
			{message ? (
				<p
					role={tone === 'error' ? 'alert' : 'status'}
					css={{
						margin: 0,
						color: tone === 'error' ? colors.error : colors.textMuted,
						fontSize: typography.fontSize.sm,
					}}
				>
					{message}
				</p>
			) : null}
		</AccountManagementPanel>
	)
}

const badgeCss: CSSObject = {
	...verifiedPillCss,
	backgroundColor: colors.primarySoftest,
	color: colors.textMuted,
}

const pendingBadgeCss: CSSObject = {
	...verifiedPillCss,
	backgroundColor: colors.primarySoftest,
	color: colors.warningText,
}
