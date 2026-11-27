/** @jsxImportSource @emotion/react */
import { Field } from '../components/field.tsx'
import { Button } from '../components/button.tsx'
import { Dialog, DialogActions } from '../components/dialog.tsx'
import {
	updateOrganizationProfile,
	deleteOrganization,
	removeOrganizationPhoto,
	saveOrganizationAvatar,
} from '#start/server/org-settings-mutations'
import type { CSSObject } from '@emotion/react'
import { useState } from 'react'
import {
	hashKey,
	useMutation,
	useQueryClient,
	type QueryKey,
} from '@tanstack/react-query'
import { useRouteContext, useRouter } from '@tanstack/react-router'
import {
	handlePermanentNote,
	handleUrlPreview,
} from '@kody-internal/shared/handle-permanence.ts'
import type { OrgSettingsLoaderData } from '#universal/loader-data.ts'
import { orgIdentity } from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import {
	getButtonCss,
	fieldCss,
	fieldLabelCss,
	fieldDescriptionCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { orgSettingsMutationOptions } from '../org-settings-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { TextLink } from '../components/text-link.tsx'
import { UserAvatar } from '../components/user-avatar.tsx'
import { renderIcon } from '../components/icon.tsx'
import { AccountAvatarEditor } from './account-avatar-editor.tsx'
import {
	OrgVisibilityFieldset,
	type OrgProfileVisibilityChoice,
} from '../components/org-visibility-fieldset.tsx'
import { OrgSettingsCustomDomains } from './org-settings-custom-domains.tsx'
import { OrgSettingsMemberCreation } from './org-settings-member-creation.tsx'
import { OrgSettingsSessionAnalytics } from './org-settings-session-analytics.tsx'
import { OrgSettingsUsageWarnings } from './org-settings-usage-warnings.tsx'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	accountActionsCss,
} from './account-management-components.tsx'
import { Input } from '../components/input.tsx'

type OrgSettingsProps = {
	data: OrgSettingsLoaderData
	queryKey: QueryKey
}

export function OrgSettingsPage(props: OrgSettingsProps) {
	return <OrgSettingsEditor key={hashKey(props.queryKey)} {...props} />
}

function OrgSettingsEditor({ data, queryKey }: OrgSettingsProps) {
	const client = useQueryClient()
	const router = useRouter()
	const { actorKey } = useRouteContext({ from: '__root__' })
	const capture = useSubmitterScope()
	const [draftName, setDraftName] = useState(data.org.displayName ?? '')
	const savedVisibility = data.profileVisibility ?? 'public'
	const [draftVisibility, setDraftVisibility] =
		useState<OrgProfileVisibilityChoice>(savedVisibility)
	const [avatarFile, setAvatarFile] = useState<File | null>(null)
	const [confirmation, setConfirmation] = useState('')
	const [message, setMessage] = useState<{
		text: string
		tone: 'info' | 'error'
	} | null>(null)
	const [deleteOpen, setDeleteOpen] = useState(false)
	const identity = orgIdentity(data.org, { displayName: '', avatarUrl: null })
	const profile = useMutation(
		orgSettingsMutationOptions(
			client,
			queryKey,
			actorKey,
			updateOrganizationProfile,
		),
	)
	const avatar = useMutation(
		orgSettingsMutationOptions(
			client,
			queryKey,
			actorKey,
			saveOrganizationAvatar,
		),
	)
	const removePhoto = useMutation(
		orgSettingsMutationOptions(
			client,
			queryKey,
			actorKey,
			removeOrganizationPhoto,
		),
	)
	const deletion = useMutation(
		orgSettingsMutationOptions(client, queryKey, actorKey, deleteOrganization),
	)
	const isPending =
		profile.isPending ||
		avatar.isPending ||
		removePhoto.isPending ||
		deletion.isPending
	async function submit<T>(
		run: () => Promise<T>,
		accepted: (result: T) => void | Promise<void>,
		allowed = data.canManage,
	) {
		if (isPending || !allowed) return
		const isCurrent = capture()
		setMessage(null)
		try {
			const result = await run()
			if (!isCurrent()) return
			setAvatarFile(null)
			await accepted(result)
		} catch (error) {
			if (isCurrent())
				setMessage({
					text:
						error instanceof Error ? error.message : 'Unable to save settings.',
					tone: 'error',
				})
		}
	}
	function saved(text: string) {
		setMessage({ text, tone: 'info' })
	}
	function uploadAvatar(file: File) {
		const form = new FormData()
		form.set('orgSlug', data.org.slug)
		form.set('avatar', file)
		return submit(
			() => avatar.mutateAsync(form),
			() => saved('Avatar updated.'),
		)
	}
	const closeDialog = () => {
		setDeleteOpen(false)
		setConfirmation('')
	}
	return (
		<AccountManagementShell
			layout="form"
			currentHref={`/@${data.org.slug}/-/settings`}
		>
			<AccountPageHeader
				entity="settings"
				title="Settings"
				description="The organization's name, handle, photo, and who can see its page."
				currentHref={`/@${data.org.slug}/-/settings`}
			/>
			{message ? (
				<AccountManagementMessage tone={message.tone}>
					{message.text}
				</AccountManagementMessage>
			) : null}
			{data.org.personal ? (
				<>
					<AccountManagementPanel title="Identity">
						<p css={mutedCopyCss}>
							This is your personal organization. Your name, photo, and handle
							come from your{' '}
							<TextLink tone="prose" href={routes.account.href()}>
								account profile
							</TextLink>
							. To delete your account, use{' '}
							<TextLink tone="prose" href={routes.accountData.href()}>
								Account → Data &amp; deletion
							</TextLink>
							.
						</p>
					</AccountManagementPanel>
					<OrgSettingsCustomDomains
						key={data.org.slug}
						data={data}
						queryKey={queryKey}
					/>
					<OrgSettingsUsageWarnings
						key={`usage-warnings:${data.org.slug}`}
						data={data}
						queryKey={queryKey}
					/>
					<OrgSettingsSessionAnalytics
						key={`session-analytics:${data.org.slug}`}
						data={data}
						queryKey={queryKey}
					/>
				</>
			) : (
				<>
					<AccountManagementPanel title="Profile">
						<div css={identityRowCss} data-testid="org-settings-identity">
							<UserAvatar
								displayName={identity.avatarName}
								avatarUrl={identity.avatarUrl}
								size={44}
								variant="well"
							/>
							<span css={identityTextCss}>
								<span css={identityNameCss}>{identity.name}</span>
								<span css={identityDetailCss}>{identity.handle}</span>
							</span>
						</div>
						{data.canManage ? (
							<div css={avatarActionsCss}>
								<label css={getButtonCss({ variant: 'secondary' })}>
									{renderIcon('photo', { size: '1.05rem' })}
									{identity.avatarUrl ? 'Change photo' : 'Add photo'}
									<input
										type="file"
										accept="image/png,image/jpeg,image/webp"
										hidden
										disabled={isPending}
										onChange={(event) => {
											const file = event.currentTarget.files?.[0]
											event.currentTarget.value = ''
											if (file) setAvatarFile(file)
										}}
									/>
								</label>
								{identity.avatarUrl ? (
									<Button
										type="button"
										variant="secondary"
										disabled={isPending}
										onClick={() =>
											void submit(
												() =>
													removePhoto.mutateAsync({ orgSlug: data.org.slug }),
												() => saved('Avatar removed.'),
											)
										}
									>
										Remove photo
									</Button>
								) : null}
							</div>
						) : null}
						{avatarFile ? (
							<AccountAvatarEditor
								file={avatarFile}
								onCancel={() => setAvatarFile(null)}
								onApply={(file) => void uploadAvatar(file)}
								onBusyChange={() => undefined}
							/>
						) : null}
						{data.canManage ? (
							<form
								css={formCss}
								onSubmit={(event) => {
									event.preventDefault()
									void submit(
										() =>
											profile.mutateAsync({
												orgSlug: data.org.slug,
												displayName: draftName,
												...(draftVisibility === savedVisibility
													? {}
													: { profileVisibility: draftVisibility }),
											}),
										() => saved('Settings saved.'),
									)
								}}
							>
								<Field label="Name">
									<Input
										name="displayName"
										required
										maxLength={80}
										value={draftName}
										onChange={(event) =>
											setDraftName(event.currentTarget.value)
										}
									/>
								</Field>
								<div css={fieldCss}>
									<span css={fieldLabelCss}>Handle</span>
									<p
										aria-describedby="org-settings-handle-note"
										css={handleValueCss}
									>
										{handleUrlPreview(data.org.slug)}
									</p>
									<p id="org-settings-handle-note" css={fieldDescriptionCss}>
										{handlePermanentNote} Change the name above to change how
										the organization appears.
									</p>
								</div>
								<OrgVisibilityFieldset
									value={draftVisibility}
									onChange={setDraftVisibility}
									handle={data.org.slug}
									disabled={isPending}
									testId="org-settings-visibility"
								/>
								<div css={accountActionsCss}>
									<Button type="submit" disabled={isPending} variant="primary">
										{profile.isPending ? 'Saving…' : 'Save changes'}
									</Button>
								</div>
							</form>
						) : (
							<>
								<p
									css={mutedCopyCss}
									data-testid="org-settings-visibility-value"
								>
									Page visibility:{' '}
									{savedVisibility === 'public'
										? 'Public. Anyone can open its page.'
										: 'Private. Only members can open its page.'}
								</p>
								<p css={mutedCopyCss}>
									Only an owner can change this organization's profile.
								</p>
							</>
						)}
					</AccountManagementPanel>
					<OrgSettingsMemberCreation
						key={`member-creation:${data.org.slug}`}
						data={data}
						queryKey={queryKey}
					/>
					<OrgSettingsCustomDomains
						key={data.org.slug}
						data={data}
						queryKey={queryKey}
					/>
					<OrgSettingsUsageWarnings
						key={`usage-warnings:${data.org.slug}`}
						data={data}
						queryKey={queryKey}
					/>
					<OrgSettingsSessionAnalytics
						key={`session-analytics:${data.org.slug}`}
						data={data}
						queryKey={queryKey}
					/>
					{data.canDelete ? (
						<AccountManagementPanel title="Delete organization">
							<p css={fieldDescriptionCss}>
								This soft-deletes the organization. Members lose access
								immediately. Owners can restore it for 30 days from Account →
								Organizations.
							</p>
							<div css={accountActionsCss}>
								<Button
									type="button"
									data-testid="delete-org"
									variant="danger"
									onClick={() => {
										setConfirmation('')
										setDeleteOpen(true)
									}}
								>
									{renderIcon('warning-triangle', { size: '1.05rem' })}Delete
									organization
								</Button>
							</div>
							<Dialog
								open={deleteOpen}
								onClose={closeDialog}
								dismissOnOutsideClick
								title={`Delete @${data.org.slug}?`}
								description={
									<>
										Type <strong>{data.org.slug}</strong> or{' '}
										<strong>DELETE</strong> to confirm.
									</>
								}
								data-testid="delete-org-dialog"
							>
								<form
									css={deleteDialogFormCss}
									onSubmit={(event) => {
										event.preventDefault()
										void submit(
											() =>
												deletion.mutateAsync({
													orgSlug: data.org.slug,
													confirmation,
												}),
											async (result) => {
												setDeleteOpen(false)
												await router.navigate({ href: result.redirectTo })
											},
											data.canDelete,
										)
									}}
								>
									<Field label="Confirmation">
										<Input
											value={confirmation}
											autoComplete="off"
											onChange={(event) =>
												setConfirmation(event.currentTarget.value)
											}
										/>
									</Field>
									<DialogActions>
										<Button
											type="submit"
											disabled={
												(confirmation !== data.org.slug &&
													confirmation !== 'DELETE') ||
												isPending
											}
											variant="danger"
										>
											{isPending ? 'Deleting…' : 'Delete organization'}
										</Button>
										<Button
											type="button"
											variant="secondary"
											onClick={closeDialog}
										>
											Cancel
										</Button>
									</DialogActions>
								</form>
							</Dialog>
						</AccountManagementPanel>
					) : null}
				</>
			)}
		</AccountManagementShell>
	)
}

const mutedCopyCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
}

const formCss: CSSObject = {
	display: 'grid',
	gap: spacing.lg,
	marginTop: spacing.md,
}

const identityRowCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.md,
}

const identityTextCss: CSSObject = {
	display: 'grid',
	gap: '0.15rem',
	minWidth: 0,
}

const identityNameCss: CSSObject = {
	fontWeight: 650,
}

const handleValueCss: CSSObject = {
	margin: 0,
	fontFamily: typography.fontFamilyMono,
	color: colors.text,
}

const identityDetailCss: CSSObject = {
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
}

const avatarActionsCss: CSSObject = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
	marginTop: spacing.md,
}

const deleteDialogFormCss: CSSObject = {
	display: 'grid',
	gap: spacing.md,
}
