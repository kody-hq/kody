/** @jsxImportSource @emotion/react */
import {
	fieldCss,
	fieldLabelCss,
	fieldDescriptionCss,
} from '#universal/styles/style-primitives.ts'
import { Button } from '../components/button.tsx'
import type { FormEvent } from 'react'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import type { AccountFormerEmail } from '#universal/loader-data.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import { AccountManagementPanel } from './account-management-components.tsx'
import { Input } from '../components/input.tsx'

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
								<Button
									type="button"
									disabled={isSending}
									variant="primary"
									onClick={() => {
										onReleaseListed(claim.email)
									}}
								>
									Release
								</Button>
								<Button
									type="button"
									disabled={isSending}
									variant="secondary"
									onClick={() => {
										onUseAgainAsLogin(claim.email)
									}}
								>
									Use again as login
								</Button>
							</div>
						</li>
					))}
				</ul>
			) : (
				<p css={fieldDescriptionCss}>
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
				<p css={fieldDescriptionCss}>
					We send a confirmation link to the former address. Releasing it does
					not change this account&apos;s identity.
				</p>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Former email</span>
					<Input
						type="email"
						name="former_email"
						id="account-former-email"
						data-testid="account-former-email"
						required
						autoComplete="off"
						value={releaseEmail}
						onInput={onReleaseEmailInput}
					/>
				</label>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Current password</span>
					<Input
						type="password"
						name="password"
						required
						{...passwordManagerIgnoreProps}
						value={releasePassword}
						onInput={onReleasePasswordInput}
					/>
				</label>
				<div>
					<Button
						type="submit"
						disabled={isSending || !releaseEmail.trim() || !releasePassword}
						variant="secondary"
					>
						{isSending ? 'Sending...' : 'Send release link'}
					</Button>
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
