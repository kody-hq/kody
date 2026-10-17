/** @jsxImportSource @emotion/react */
import { SiteLink } from '../components/site-link.tsx'
import { type FormEvent } from 'react'
import {
	handlePermanentNote,
	handleUrlPreview,
} from '@kody-internal/shared/handle-permanence.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { PasswordRevealInput } from '../components/password-reveal-input.tsx'
import { type ProfileVisibility } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { UserAvatar } from '../components/user-avatar.tsx'
import { renderIcon } from '../components/icon.tsx'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
	hoverMq,
	mutedLinkCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import {
	AccountManagementPanel,
	accountDisclosureCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
	accountTextareaCss,
	verifiedPillCss,
} from './account-management-components.tsx'
export type AccountProfilePanelProps = {
	email: string
	emailVerified: boolean
	username: string
	draftDisplayName: string
	draftBio: string
	draftProfileVisibility: ProfileVisibility
	draftEmail: string
	emailChangePassword: string
	avatarUrl: string | null
	avatarStatus: 'idle' | 'editing' | 'uploading' | 'removing'
	isSaving: boolean
	isSendingEmailChange: boolean
	profileUnchanged: boolean
	normalizedDraftEmail: string
	emailChangeMessage: string | null
	emailChangeTone: 'error' | 'info'
	emailChangeOpen: boolean
	onProfileSubmit: (event: FormEvent<HTMLFormElement>) => void
	onEmailChangeSubmit: (event: FormEvent<HTMLFormElement>) => void
	onAvatarSelected: (event: FormEvent<HTMLElement>) => void
	onRemoveAvatar: () => void
	onDraftDisplayNameChange: (value: string) => void
	onDraftBioChange: (value: string) => void
	onDraftProfileVisibilityChange: (value: ProfileVisibility) => void
	onDraftEmailInput: (event: FormEvent<HTMLInputElement>) => void
	onEmailChangeToggle: (event: FormEvent<HTMLDetailsElement>) => void
	onEmailChangePasswordInput: (event: FormEvent<HTMLInputElement>) => void
}
export function AccountProfilePanel(props: AccountProfilePanelProps) {
	const {
		email,
		emailVerified,
		username,
		draftDisplayName,
		draftBio,
		draftProfileVisibility,
		draftEmail,
		emailChangePassword,
		avatarUrl,
		avatarStatus,
		isSaving,
		isSendingEmailChange,
		profileUnchanged,
		normalizedDraftEmail,
		emailChangeMessage,
		emailChangeTone,
		emailChangeOpen,
		onProfileSubmit,
		onEmailChangeSubmit,
		onAvatarSelected,
		onRemoveAvatar,
		onDraftDisplayNameChange,
		onDraftBioChange,
		onDraftProfileVisibilityChange,
		onDraftEmailInput,
		onEmailChangeToggle,
		onEmailChangePasswordInput,
	} = props
	return (
		<AccountManagementPanel
			title="Profile details"
			description="Your username is permanent. Display name, bio, avatar, and visibility control your public profile at your @handle."
		>
			<form
				css={{ display: 'grid', gap: spacing.md, maxWidth: '34rem' }}
				onSubmit={onProfileSubmit}
			>
				<div css={avatarSectionCss} data-testid="account-avatar">
					<label
						css={{
							...avatarEditCss,
							cursor:
								avatarStatus !== 'idle' || isSaving ? 'not-allowed' : 'pointer',
							opacity: avatarStatus !== 'idle' || isSaving ? 0.7 : 1,
						}}
					>
						<UserAvatar
							displayName={draftDisplayName || username}
							avatarUrl={avatarUrl}
							size={accountAvatarSize}
							testId="account-avatar-image"
						/>
						<input
							type="file"
							name="avatar"
							accept="image/*,.heic,.heif"
							disabled={avatarStatus !== 'idle' || isSaving}
							data-testid="account-avatar-file"
							css={visuallyHiddenCss}
							onChange={(event) => {
								void onAvatarSelected(event)
							}}
						/>
						<span data-avatar-edit-affordance css={avatarEditAffordanceCss}>
							{avatarEditIcon()}
						</span>
						<span css={visuallyHiddenCss}>Change avatar</span>
					</label>
					{avatarUrl ? (
						<button
							type="button"
							disabled={avatarStatus !== 'idle' || isSaving}
							css={compactGhostButtonCss}
							onClick={() => {
								void onRemoveAvatar()
							}}
						>
							{avatarStatus === 'removing' ? 'Removing...' : 'Remove avatar'}
						</button>
					) : null}
				</div>
				<div css={accountFieldCss}>
					<span css={accountFieldLabelCss}>Username</span>
					<p
						id="account-username"
						data-testid="account-username"
						aria-describedby="account-username-note"
						css={usernameValueCss}
					>
						{handleUrlPreview(username)}
					</p>
					<p id="account-username-note" css={accountFieldNoteCss}>
						{handlePermanentNote} Change your display name below to change how
						you appear.
					</p>
				</div>
				<label css={accountFieldCss}>
					<span css={accountFieldLabelCss}>Display name</span>
					<input
						type="text"
						name="displayName"
						data-field-ring
						maxLength={50}
						autoComplete="nickname"
						value={draftDisplayName}
						css={accountInputCss}
						onInput={(event) => {
							onDraftDisplayNameChange(
								(event.currentTarget as HTMLInputElement).value,
							)
						}}
					/>
				</label>
				<label css={accountFieldCss}>
					<span css={accountFieldLabelCss}>Bio</span>
					<textarea
						name="bio"
						data-field-ring
						maxLength={500}
						rows={3}
						value={draftBio}
						css={accountTextareaCss}
						onInput={(event) => {
							onDraftBioChange(
								(event.currentTarget as HTMLTextAreaElement).value,
							)
						}}
					/>
				</label>
				<fieldset css={{ margin: 0, padding: 0, border: 'none' }}>
					<legend css={accountFieldLabelCss}>Profile visibility</legend>
					<label
						css={{
							display: 'flex',
							gap: spacing.sm,
							alignItems: 'center',
							marginTop: spacing.sm,
						}}
					>
						<input
							type="radio"
							name="profileVisibility"
							value="public"
							checked={draftProfileVisibility === 'public'}
							onChange={() => {
								onDraftProfileVisibilityChange('public')
							}}
						/>
						<span>Public</span>
					</label>
					<label
						css={{
							display: 'flex',
							gap: spacing.sm,
							alignItems: 'center',
							marginTop: spacing.xs,
						}}
					>
						<input
							type="radio"
							name="profileVisibility"
							value="private"
							checked={draftProfileVisibility === 'private'}
							onChange={() => {
								onDraftProfileVisibilityChange('private')
							}}
						/>
						<span>Private</span>
					</label>
					<p css={accountFieldNoteCss}>
						Private hides your profile, public package list, and activity from
						others.
					</p>
				</fieldset>
				<p css={accountFieldNoteCss}>
					Email: {email}
					{emailVerified ? (
						<span css={verifiedPillCss}>verified</span>
					) : (
						' (unverified)'
					)}
				</p>
				<p css={{ margin: 0 }}>
					<SiteLink href={routes.profile.href({ username })} css={mutedLinkCss}>
						View public profile
					</SiteLink>
				</p>
				<div>
					<button
						type="submit"
						disabled={isSaving || profileUnchanged}
						css={compactPillButtonCss}
					>
						{isSaving ? 'Saving...' : 'Save profile'}
					</button>
				</div>
			</form>
			{emailVerified ? (
				<details
					open={emailChangeOpen ? true : undefined}
					data-testid="account-change-email"
					css={{
						...accountDisclosureCss,
						marginTop: '0.6rem',
					}}
					onToggle={onEmailChangeToggle}
				>
					<summary>Change email</summary>
					<form
						{...passwordManagerIgnoreProps}
						css={{
							display: 'grid',
							gap: spacing.md,
							maxWidth: '26rem',
						}}
						onSubmit={onEmailChangeSubmit}
					>
						<p css={accountFieldNoteCss}>
							Enter your current password. We will send a verification link to
							the new address before changing your account email.
						</p>
						<p css={accountFieldNoteCss}>
							After you switch, your current verified address stays tied to this
							account and cannot open a second account unless you release it
							from Former addresses.
						</p>
						<label css={accountFieldCss}>
							<span css={accountFieldLabelCss}>New email</span>
							<input
								type="email"
								name="email"
								id="account-new-email"
								data-testid="account-new-email"
								data-field-ring
								required
								autoComplete="off"
								value={draftEmail}
								css={accountInputCss}
								onInput={onDraftEmailInput}
							/>
						</label>
						<div css={accountFieldCss}>
							<label
								htmlFor="account-email-change-password"
								css={accountFieldLabelCss}
							>
								Current password
							</label>
							<PasswordRevealInput
								id="account-email-change-password"
								name="password"
								data-field-ring
								required
								{...passwordManagerIgnoreProps}
								value={emailChangePassword}
								css={accountInputCss}
								onInput={onEmailChangePasswordInput}
							/>
						</div>
						<div>
							<button
								type="submit"
								disabled={
									isSendingEmailChange ||
									normalizedDraftEmail === email.trim().toLowerCase()
								}
								css={compactGhostButtonCss}
							>
								{isSendingEmailChange ? 'Sending...' : 'Send verification link'}
							</button>
						</div>
						{emailChangeMessage ? (
							<p
								role="status"
								css={{
									color:
										emailChangeTone === 'error' ? colors.error : colors.text,
									margin: 0,
								}}
							>
								{emailChangeMessage}
							</p>
						) : null}
					</form>
				</details>
			) : (
				<p css={{ ...accountFieldNoteCss, marginTop: '0.6rem' }}>
					Verify your current email address before changing it.
				</p>
			)}
		</AccountManagementPanel>
	)
}
/* `.account-form .button` / `.account-actions .button` — the prototype's
 * compact pill sizing for in-section actions. */
const compactPillButtonCss = getPillButtonCss({ size: 'sm' })
const compactGhostButtonCss = getGhostButtonCss({ size: 'sm' })
const accountAvatarSize = 128
const avatarSectionCss = {
	display: 'grid',
	gap: spacing.sm,
	justifyItems: 'start' as const,
}
const avatarEditCss = {
	position: 'relative' as const,
	display: 'inline-block',
	width: `${accountAvatarSize}px`,
	height: `${accountAvatarSize}px`,
	borderRadius: radius.full,
	[hoverMq]: {
		'& [data-avatar-edit-affordance]': {
			opacity: 0,
		},
		'&:hover [data-avatar-edit-affordance], &:focus-within [data-avatar-edit-affordance]':
			{
				opacity: 1,
			},
	},
}
const avatarEditAffordanceCss = {
	position: 'absolute' as const,
	right: '0.15rem',
	bottom: '0.15rem',
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '2.25rem',
	height: '2.25rem',
	borderRadius: radius.full,
	backgroundColor: colors.surface,
	color: colors.text,
	border: `1px solid ${colors.border}`,
	boxShadow: shadows.md,
	opacity: 1,
	pointerEvents: 'none' as const,
}
function avatarEditIcon() {
	return renderIcon('edit', { size: '16' })
}
const usernameValueCss = {
	margin: 0,
	fontFamily: typography.fontFamilyMono,
	color: colors.text,
}
