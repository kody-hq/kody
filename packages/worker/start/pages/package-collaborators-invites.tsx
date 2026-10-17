/** @jsxImportSource @emotion/react */
import { useState, type FormEvent } from 'react'
import { useInviteHandoff } from '../use-invite-handoff.ts'
import { CopyTextButton } from '../components/copy-text-button.tsx'
import { SiteLink } from '../components/site-link.tsx'
import { formatTimestampDate } from '../components/local-timestamp.tsx'
import {
	AccountManagementPanel,
	accountActionsCss,
	accountDisclosureCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
} from './account-management-components.tsx'
import { renderIcon } from '../components/icon.tsx'
import {
	type PackageCollaboratorInviteCreated,
	type PackageCollaboratorInviteView,
	type PackageCollaboratorPreset,
	type PackageCollaboratorsChange,
	type PackageCollaboratorsView,
	type PackageCollaboratorsWriteResult,
	packageCollaboratorInvitePresetExplanation,
	packageCollaboratorInviteeLabel,
	packageCollaboratorPresetLabel,
	packageCollaboratorPresets,
} from '#universal/package-collaborators.ts'
import { routes } from '#universal/routes.ts'
import {
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	formCss,
	iconWellCss,
	listCss,
	mutedCopyCss,
	rowActionsCss,
	rowCss,
	rowDetailCss,
	rowNameCss,
	rowTextCss,
} from './package-collaborators-parts.tsx'

type PostChange = (
	key: string,
	change: PackageCollaboratorsChange,
	success: string,
) => Promise<PackageCollaboratorsWriteResult | null>

/** One-time invite messages stay local to the submitted actor and package. */
export function PackageCollaboratorInvites({
	view,
	busyKey,
	postChange,
}: {
	view: PackageCollaboratorsView
	busyKey: string | null
	postChange: PostChange
}) {
	const [invitee, setInvitee] = useState('')
	const [preset, setPreset] = useState<PackageCollaboratorPreset>('use')
	const [created, setCreated] =
		useInviteHandoff<PackageCollaboratorInviteCreated>(view.invites)
	const [confirmed, setConfirmed] = useState<string | null>(null)
	const busy = busyKey !== null
	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		// Failed attempts must preserve the previous unrecoverable handoff.
		const result = await postChange(
			'invite',
			{ intent: 'invite', invitee: invitee.trim(), preset },
			'Invite created.',
		)
		if (result?.invite) {
			setInvitee('')
			setPreset('use')
			setCreated(result.invite)
		}
	}
	async function revoke(invite: PackageCollaboratorInviteView) {
		if (confirmed !== invite.id) {
			setConfirmed(invite.id)
			return
		}
		const result = await postChange(
			`revoke-invite:${invite.id}`,
			{ intent: 'revoke-invite', inviteId: invite.id },
			`Revoked the invite for ${packageCollaboratorInviteeLabel(invite)}.`,
		)
		if (result) {
			setConfirmed(null)
			setCreated((current) => (current?.id === invite.id ? null : current))
		}
	}
	return (
		<>
			<AccountManagementPanel
				title="Invite a collaborator"
				description="Share this one package with someone outside your account. They get only this package, not your other packages or your credentials. Runs they start count toward your usage."
			>
				<form
					data-testid="package-collaborators-invite"
					css={formCss}
					onSubmit={(event) => void submit(event)}
				>
					<label css={accountFieldCss}>
						<span css={accountFieldLabelCss}>Email or username</span>
						<input
							value={invitee}
							required
							data-field-ring
							autoComplete="off"
							placeholder="jesse@example.com or @jesse"
							css={accountInputCss}
							onChange={(event) => setInvitee(event.currentTarget.value)}
						/>
						<p css={accountFieldNoteCss}>
							They need a Kody account with this email or username to accept.
						</p>
					</label>
					<fieldset css={fieldsetCss}>
						<legend css={legendCss}>What they can do</legend>
						{packageCollaboratorPresets.map((option) => (
							<label
								key={option}
								css={option === preset ? presetCardCheckedCss : presetCardCss}
							>
								<input
									type="radio"
									name="package-invite-preset"
									value={option}
									checked={option === preset}
									css={presetRadioCss}
									onChange={() => setPreset(option)}
								/>
								<span css={{ display: 'grid', gap: '0.15rem' }}>
									<span css={{ fontWeight: 650 }}>
										{packageCollaboratorPresetLabel(option)}
									</span>
									<span css={rowDetailCss}>
										{packageCollaboratorInvitePresetExplanation(option)}
									</span>
								</span>
							</label>
						))}
					</fieldset>
					<div css={accountActionsCss}>
						<button
							type="submit"
							disabled={busy || !invitee.trim()}
							css={getPillButtonCss({ size: 'sm' })}
						>
							{renderIcon('mail', { size: '1.05rem' })}
							{busyKey === 'invite' ? 'Creating…' : 'Create invite'}
						</button>
					</div>
				</form>
				{created ? (
					<div
						data-testid="package-collaborators-invite-ready"
						css={handoffCss}
					>
						<p css={{ margin: 0, fontWeight: 650 }}>
							Invite ready for {created.inviteeLabel}
						</p>
						<p css={mutedCopyCss}>
							Send this message to them. They paste it into their own agent
							connected to Kody to accept{' '}
							{packageCollaboratorPresetLabel(created.preset).toLowerCase()}{' '}
							access. It is shown only once and expires{' '}
							{formatTimestampDate(created.expiresAt)}.
						</p>
						<div css={accountActionsCss}>
							<CopyTextButton
								value={created.prompt}
								idleLabel="Copy invite message"
								variant="pill"
								size="sm"
							/>
						</div>
						<details css={accountDisclosureCss}>
							<summary>Details</summary>
							<pre css={promptCss} data-testid="package-collaborators-prompt">
								{created.prompt}
							</pre>
						</details>
					</div>
				) : null}
				<aside
					data-testid="package-collaborators-team-callout"
					aria-label="Team organizations"
					css={calloutCss}
				>
					<span aria-hidden="true" css={iconWellCss}>
						{renderIcon('users', { size: '1.25rem' })}
					</span>
					<div css={calloutBodyCss}>
						<p css={{ margin: 0, fontWeight: 650 }}>Working with a group?</p>
						<p css={calloutCopyCss}>
							A team organization gives you members, teams, and seats, so you
							share packages with everyone at once instead of one invite at a
							time.
						</p>
						<div css={calloutActionsCss}>
							<SiteLink
								href={routes.accountOrganizationsNew.href()}
								css={calloutButtonCss}
							>
								{renderIcon('plus', { size: '1.05rem' })}Create a team
								organization
							</SiteLink>
							<SiteLink href={routes.docDetail.href({ slug: 'organizations' })}>
								Learn more
							</SiteLink>
						</div>
					</div>
				</aside>
			</AccountManagementPanel>
			{view.invites.length ? (
				<AccountManagementPanel
					title="Pending invites"
					description="Invites that have not been accepted yet. Revoke one to stop it from working."
				>
					<ul css={listCss} data-testid="package-collaborator-invites">
						{view.invites.map((invite) => (
							<li
								key={invite.id}
								data-testid="package-collaborator-invite"
								css={rowCss}
							>
								<span aria-hidden="true" css={iconWellCss}>
									{renderIcon('mail', { size: '1.25rem' })}
								</span>
								<span css={rowTextCss}>
									<span css={rowNameCss}>
										{packageCollaboratorInviteeLabel(invite)}
									</span>
									<span css={rowDetailCss}>
										{[
											invite.preset
												? packageCollaboratorPresetLabel(invite.preset)
												: 'Custom access',
											`Expires ${formatTimestampDate(invite.expiresAt)}`,
										].join(' · ')}
									</span>
								</span>
								<span css={rowActionsCss}>
									<button
										type="button"
										disabled={busy}
										css={getDangerPillCss({ size: 'sm' })}
										onClick={() => void revoke(invite)}
									>
										{renderIcon('close', { size: '1.05rem' })}
										{confirmed === invite.id ? 'Confirm revoke' : 'Revoke'}
									</button>
								</span>
							</li>
						))}
					</ul>
				</AccountManagementPanel>
			) : null}
		</>
	)
}

const fieldsetCss = {
	margin: 0,
	padding: 0,
	border: 'none',
	display: 'grid',
	gap: spacing.sm,
	minWidth: 0,
}

const legendCss = {
	padding: 0,
	marginBottom: spacing.xs,
	fontWeight: 600,
}

const presetCardCss = {
	display: 'flex',
	alignItems: 'flex-start',
	gap: spacing.sm,
	padding: '0.75rem 0.9rem',
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
	cursor: 'pointer',
	minWidth: 0,
}

const presetCardCheckedCss = {
	...presetCardCss,
	borderColor: colors.primary,
}

const presetRadioCss = {
	marginTop: '0.25rem',
	flexShrink: 0,
	accentColor: colors.primary,
}

const handoffCss = {
	display: 'grid',
	gap: spacing.sm,
	padding: spacing.md,
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.background,
}

const promptCss = {
	margin: 0,
	padding: spacing.md,
	borderRadius: radius.card,
	backgroundColor: colors.surface,
	color: colors.text,
	fontSize: typography.fontSize.sm,
	whiteSpace: 'pre-wrap' as const,
	overflowWrap: 'anywhere' as const,
}

const calloutCss = {
	display: 'flex',
	alignItems: 'flex-start',
	gap: spacing.md,
	padding: spacing.md,
	borderRadius: radius.card,
	border: `1.5px dashed ${colors.border}`,
	boxSizing: 'border-box' as const,
	minWidth: 0,
	maxWidth: '100%',
	// Space above the next AccountManagementPanel border (Pending invites).
	marginBottom: spacing.xl,
	[mq.mobile]: {
		flexDirection: 'column' as const,
		alignItems: 'stretch',
		gap: spacing.sm,
	},
}

const calloutBodyCss = {
	display: 'grid',
	gap: spacing.sm,
	minWidth: 0,
	flex: '1 1 auto',
	maxWidth: '100%',
}

const calloutCopyCss = {
	...mutedCopyCss,
	overflowWrap: 'anywhere' as const,
	maxWidth: '100%',
}

const calloutActionsCss = {
	...accountActionsCss,
	minWidth: 0,
	maxWidth: '100%',
}

const calloutButtonCss = {
	...getGhostButtonCss({ size: 'sm' }),
	maxWidth: '100%',
	boxSizing: 'border-box' as const,
	whiteSpace: 'normal' as const,
	height: 'auto',
	textAlign: 'center' as const,
}
