/** @jsxImportSource @emotion/react */
import { type FormEvent } from 'react'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { type AccountFormerEmail } from '#universal/loader-data.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
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
} from './account-management-components.tsx'

export type AccountFormerEmailsPanelProps = {
	formerEmails: Array<AccountFormerEmail>
	releaseEmail: string
	releasePassword: string
	releaseStatus: 'idle' | 'sending'
	releaseMessage: string | null
	releaseTone: 'error' | 'info'
	onReleaseEmailInput: (event: FormEvent<HTMLInputElement>) => void
	onReleasePasswordInput: (event: FormEvent<HTMLInputElement>) => void
	onReleaseSubmit: (event: FormEvent<HTMLFormElement>) => void
	onUseAgainAsLogin: (email: string) => void
	onReleaseListed: (email: string) => void
}

export function AccountFormerEmailsPanel(props: AccountFormerEmailsPanelProps) {
	const {
		formerEmails,
		releaseEmail,
		releasePassword,
		releaseStatus,
		releaseMessage,
		releaseTone,
		onReleaseEmailInput,
		onReleasePasswordInput,
		onReleaseSubmit,
		onUseAgainAsLogin,
		onReleaseListed,
	} = props
	const compactGhostButtonCss = getGhostButtonCss({ size: 'sm' })
	const compactPillButtonCss = getPillButtonCss({ size: 'sm' })
	const isSending = releaseStatus === 'sending'

	return (
		<AccountManagementPanel
			title="Former addresses"
			description="Verified emails that still belong to this account. Release one after you confirm you still own it if you want that address to open a new Kody account."
		>
			{formerEmails.length > 0 ? (
				<ul
					css={{
						listStyle: 'none',
						margin: 0,
						padding: 0,
						display: 'grid',
						gap: spacing.md,
					}}
				>
					{formerEmails.map((claim) => (
						<li
							key={claim.email}
							css={{
								display: 'grid',
								gap: spacing.sm,
							}}
						>
							<p css={{ margin: 0 }}>{claim.email}</p>
							<div
								css={{
									display: 'flex',
									flexWrap: 'wrap',
									gap: spacing.sm,
								}}
							>
								<button
									type="button"
									disabled={isSending}
									css={compactPillButtonCss}
									onClick={() => {
										onReleaseListed(claim.email)
									}}
								>
									Release
								</button>
								<button
									type="button"
									disabled={isSending}
									css={compactGhostButtonCss}
									onClick={() => {
										onUseAgainAsLogin(claim.email)
									}}
								>
									Use again as login
								</button>
							</div>
						</li>
					))}
				</ul>
			) : (
				<p css={accountFieldNoteCss}>
					No former addresses are listed yet. If you changed email before this
					list existed, enter that old verified address below to release it.
				</p>
			)}
			<form
				method="post"
				{...passwordManagerIgnoreProps}
				css={{
					display: 'grid',
					gap: spacing.md,
					maxWidth: '26rem',
					marginTop: spacing.sm,
				}}
				onSubmit={onReleaseSubmit}
			>
				<p css={accountFieldNoteCss}>
					We send a confirmation link to the former address. Releasing it does
					not change this account&apos;s identity.
				</p>
				<label css={accountFieldCss}>
					<span css={accountFieldLabelCss}>Former email</span>
					<input
						type="email"
						name="former_email"
						id="account-former-email"
						data-testid="account-former-email"
						data-field-ring
						required
						autoComplete="off"
						value={releaseEmail}
						css={accountInputCss}
						onInput={onReleaseEmailInput}
					/>
				</label>
				<label css={accountFieldCss}>
					<span css={accountFieldLabelCss}>Current password</span>
					<input
						type="password"
						name="password"
						data-field-ring
						required
						{...passwordManagerIgnoreProps}
						value={releasePassword}
						css={accountInputCss}
						onInput={onReleasePasswordInput}
					/>
				</label>
				<div>
					<button
						type="submit"
						disabled={isSending || !releaseEmail.trim() || !releasePassword}
						css={compactGhostButtonCss}
					>
						{isSending ? 'Sending...' : 'Send release link'}
					</button>
				</div>
				{releaseMessage ? (
					<p
						role="status"
						css={{
							color: releaseTone === 'error' ? colors.error : colors.text,
							margin: 0,
						}}
					>
						{releaseMessage}
					</p>
				) : null}
			</form>
		</AccountManagementPanel>
	)
}
