/** @jsxImportSource @emotion/react */
import { ModalDialog } from '../components/modal-dialog.tsx'
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { colors } from '#universal/styles/tokens.ts'
import { getSelectCss } from '#universal/styles/style-primitives.ts'
import {
	assetCacheControls,
	defaultFileAssetSettings,
} from '#universal/file-assets.ts'
import type { FileMetadata } from '#universal/files.ts'
import {
	filePermissionOptions,
	type FilePermission,
} from '#universal/file-permissions.ts'
import {
	workspacePageMediaType,
	workspaceDirectoryMediaType,
} from '#universal/workspace-page.ts'
import {
	readFilePermissions,
	configureFileAsset,
	createSignedFileAsset,
	changeFileCollaborator,
	revokeFileInvitation,
} from '#start/server/file-permissions'
import { manageWorkspaceFile, shareFile } from '#start/server/files'
import { setFilePublicLink } from '#start/server/public-files'
import { accountInputCss } from './account-management-components.tsx'
import { LoadingIndicator } from '../components/loading-indicator.tsx'
import { Combobox } from '../components/combobox.tsx'
import { UserAvatar } from '../components/user-avatar.tsx'
import {
	ContextMenuSurface,
	ContextMenuButton,
} from '../components/context-menu-surface.tsx'
import { SiteLink } from '../components/site-link.tsx'

const button = {
	border: 0,
	background: 'transparent',
	color: colors.text,
	padding: '7px 10px',
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	gap: 7,
	minHeight: 32,
	textDecoration: 'none',
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: 2,
	},
	'@media (pointer: coarse)': { minHeight: 40 },
	borderRadius: 5,
	font: 'inherit',
	cursor: 'pointer',
	whiteSpace: 'nowrap',
	flexShrink: 0,
	'&:hover': { background: colors.borderSubtle },
	'&:disabled': { opacity: 0.45, cursor: 'default' },
	'&[hidden]': { display: 'none' },
} as const
const linkField = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	gap: 6,
}
const linkInput = {
	...accountInputCss,
	width: 'auto',
	flex: '1 1 180px',
	minWidth: 0,
	textOverflow: 'ellipsis',
}
const presets = [
	{ value: 'read', label: 'Can view' },
	{ value: 'contribute', label: 'Can edit' },
	{ value: 'manage', label: 'Can manage' },
] as const
type Preset = (typeof presets)[number]['value']
function CustomAccess({
	label,
	permissions,
	disabled,
	onSave,
}: {
	label: string
	permissions: string[]
	disabled: boolean
	onSave: (permissions: FilePermission[]) => void
}) {
	const [selected, setSelected] = useState<FilePermission[]>(
		filePermissionOptions
			.filter((option) => permissions.includes(option.permission))
			.map((option) => option.permission),
	)
	return (
		<details css={{ gridColumn: '1 / -1', fontSize: 12 }}>
			<summary css={{ cursor: 'pointer', color: colors.textMuted }}>
				Custom permissions for {label}
			</summary>
			<fieldset
				disabled={disabled}
				aria-label={`Custom permissions for ${label}`}
				css={{
					border: 0,
					margin: '8px 0',
					padding: 0,
					display: 'grid',
					gap: 8,
				}}
			>
				{filePermissionOptions.map((option) => (
					<label
						key={option.permission}
						css={{ display: 'flex', alignItems: 'center', gap: 8 }}
					>
						<input
							type="checkbox"
							checked={selected.includes(option.permission)}
							onChange={(event) =>
								setSelected((current) =>
									event.target.checked
										? [...current, option.permission]
										: current.filter(
												(permission) => permission !== option.permission,
											),
								)
							}
						/>
						{option.label}
					</label>
				))}
				<button
					type="button"
					css={button}
					disabled={!selected.includes('file:read')}
					onClick={() => onSave(selected)}
				>
					Save custom permissions
				</button>
			</fieldset>
		</details>
	)
}
function AccessSelect({
	value,
	disabled,
	label,
	onChange,
}: {
	value: string
	disabled?: boolean
	label: string
	onChange: (value: Preset) => void
}) {
	return (
		<select
			aria-label={label}
			value={value}
			disabled={disabled}
			data-field-ring
			css={{
				...getSelectCss(),
				width: 'auto',
				minWidth: 130,
				maxWidth: '100%',
				padding: '7px 32px 7px 10px',
				fontSize: 13,
			}}
			onChange={(event) => onChange(event.target.value as Preset)}
		>
			{!presets.some((option) => option.value === value) && (
				<option value={value}>Custom access</option>
			)}
			{presets.map((option) => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
		</select>
	)
}
export default function FilePermissionsPanel({
	item,
	orgSlug,
	onClose,
	onAccessChange,
}: {
	item: FileMetadata
	orgSlug: string
	onClose: () => void
	onAccessChange: () => void
}) {
	const query = useQuery({
		queryKey: ['file-permissions', orgSlug, item.id],
		queryFn: () => readFilePermissions({ data: { orgSlug, fileId: item.id } }),
		staleTime: 0,
	})
	const [busy, setBusy] = useState(false)
	const lock = useRef(false)
	const [error, setError] = useState('')
	const [recipient, setRecipient] = useState('')
	const [inviteEmail, setInviteEmail] = useState('')
	const [preset, setPreset] = useState<Preset>('read')
	const [inviteLink, setInviteLink] = useState('')
	const [publicLink, setPublicLink] = useState('')
	const [signedAssetLink, setSignedAssetLink] = useState('')
	const [copied, setCopied] = useState('')
	const [tab, setTab] = useState<'sharing' | 'details'>('sharing')
	const [confirmRotate, setConfirmRotate] = useState(false)
	useEffect(() => {}, [])
	async function mutate(work: () => Promise<unknown>) {
		if (lock.current) return
		lock.current = true
		setBusy(true)
		setError('')
		try {
			await work()
			await query.refetch({ throwOnError: true })
			onAccessChange()
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: 'Could not update access. Try again.',
			)
		} finally {
			lock.current = false
			setBusy(false)
		}
	}
	async function copy(value: string) {
		try {
			await navigator.clipboard.writeText(new URL(value, location.origin).href)
			setCopied(value)
		} catch {
			setError('Could not copy. Select the link below.')
		}
	}
	const data = query.data
	const restrictedParent = data?.ancestors.find((parent) => parent.restricted)
	const options = data?.direct?.options
	const recipientOptions = [
		{
			id: 'email',
			label: 'Invite by email',
			keywords: ['outside', 'external'],
		},
		...(!data?.personal && options?.everyone
			? [
					{
						id: `org:${options.everyone.orgId}`,
						label: 'Everyone in this organization',
						keywords: ['organization'],
					},
				]
			: []),
		...(options?.teams.map((team) => ({
			id: `team:${team.id}`,
			label: team.name,
			keywords: ['team'],
		})) ?? []),
		...(options?.members.flatMap((person) => {
			const label = person.displayName || person.username
			return label
				? [
						{
							id: `user:${person.userId}`,
							label,
							keywords: person.username ? [person.username] : [],
						},
					]
				: []
		}) ?? []),
	]
	const link =
		data?.publicLinkEnabled && !restrictedParent
			? (data.publicLink ?? publicLink)
			: ''
	const assetSettings = data?.assetSettings ?? defaultFileAssetSettings
	const publicAssetLink = link
		? `${link.replace('/shared-files/', '/shared-file-assets/')}/${item.id}?asset=1`
		: ''
	return (
		<ModalDialog
			label={`Details and permissions for ${item.name}`}
			onClose={onClose}
			width={480}
			sidePanel
		>
			<header
				css={{
					display: 'flex',
					alignItems: 'center',
					gap: 12,
					padding: '16px 20px',
					borderBottom: `1px solid ${colors.border}`,
				}}
			>
				<div css={{ flex: 1, minWidth: 0 }}>
					<h2 css={{ margin: 0, fontSize: 17, overflowWrap: 'anywhere' }}>
						{item.name}
					</h2>
				</div>
				<button aria-label="Close details" css={button} onClick={onClose}>
					<svg
						width="16"
						height="16"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						aria-hidden="true"
					>
						<path d="m4 4 8 8M12 4l-8 8" />
					</svg>
				</button>
			</header>
			<div
				role="tablist"
				aria-label="File settings"
				css={{
					display: 'flex',
					gap: 20,
					paddingInline: 20,
					borderBottom: `1px solid ${colors.border}`,
					flexShrink: 0,
				}}
			>
				{(['sharing', 'details'] as const).map((value) => (
					<button
						key={value}
						type="button"
						role="tab"
						aria-selected={tab === value}
						aria-controls={`file-${value}`}
						id={`file-${value}-tab`}
						onClick={() => setTab(value)}
						onKeyDown={(event) => {
							if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
								event.preventDefault()
								const next = value === 'sharing' ? 'details' : 'sharing'
								setTab(next)
								document.getElementById(`file-${next}-tab`)?.focus()
							}
						}}
						tabIndex={tab === value ? 0 : -1}
						css={{
							...button,
							borderRadius: 0,
							padding: '12px 0',
							borderBottom: `2px solid ${tab === value ? colors.primary : 'transparent'}`,
							color: tab === value ? colors.text : colors.textMuted,
						}}
					>
						{value === 'sharing' ? 'Sharing' : 'Details'}
					</button>
				))}
			</div>
			<div
				role="tabpanel"
				id={`file-${tab}`}
				aria-labelledby={`file-${tab}-tab`}
				css={{
					overflowY: 'auto',
					minHeight: 0,
					flex: 1,
					padding: 20,
					display: 'grid',
					alignContent: 'start',
					gap: 18,
					fontSize: 13,
					'& h3': { margin: '0 0 12px', fontSize: 13, fontWeight: 650 },
					'& p': {
						margin: '8px 0',
						color: colors.textMuted,
						fontSize: 12,
						lineHeight: 1.5,
					},
				}}
			>
				{query.isPending ? (
					<LoadingIndicator label="Loading permissions" />
				) : query.isError ? (
					<div role="alert">
						Could not load permissions.{' '}
						<button css={button} onClick={() => void query.refetch()}>
							Retry
						</button>
					</div>
				) : (
					data && (
						<>
							<section aria-label="File details" hidden={tab !== 'details'}>
								<dl
									css={{
										margin: 0,
										display: 'grid',
										gridTemplateColumns: '90px 1fr',
										gap: '8px 12px',
										'& dt': { color: colors.textMuted },
										'& dd': { margin: 0, overflowWrap: 'anywhere' },
									}}
								>
									<dt>Type</dt>
									<dd>
										{item.mediaType === workspacePageMediaType
											? 'Page'
											: item.mediaType === workspaceDirectoryMediaType
												? 'Folder'
												: item.name.includes('.')
													? `${item.name.split('.').at(-1)!.toUpperCase()} file`
													: 'File'}
									</dd>
									<dt>Modified</dt>
									<dd>{new Date(data.file.updatedAt).toLocaleString()}</dd>
									<dt>Location</dt>
									<dd>
										{data.ancestors.length ? (
											<SiteLink
												href={`/@${orgSlug}/-/files?file=${data.ancestors[0]!.id}`}
												onClick={onClose}
											>
												{data.ancestors[0]!.name}
											</SiteLink>
										) : (
											'Files'
										)}
									</dd>
								</dl>
							</section>

							{data.access.manage && (
								<section
									aria-label="People and teams"
									hidden={tab !== 'sharing'}
									css={{
										borderBottom: `1px solid ${colors.border}`,
										paddingBottom: 20,
									}}
								>
									<h3>People &amp; teams</h3>
									{data.direct?.collaborators.map((person) => (
										<div
											key={person.grantId}
											css={{
												display: 'grid',
												gridTemplateColumns: 'minmax(0, 1fr) auto auto',
												alignItems: 'center',
												gap: 8,
												paddingBlock: 7,
											}}
										>
											<div
												css={{
													display: 'flex',
													alignItems: 'center',
													gap: 10,
													minWidth: 0,
												}}
											>
												<UserAvatar
													displayName={person.displayName || person.label}
													avatarUrl={null}
													size={30}
												/>
												<div css={{ minWidth: 0 }}>
													<div>{person.displayName || person.label}</div>
													<span css={{ color: colors.textMuted, fontSize: 11 }}>
														{person.kind === 'team'
															? 'Team'
															: person.kind === 'org'
																? 'Organization'
																: person.kind === 'outside'
																	? 'Outside collaborator'
																	: 'Member'}
														{person.expiresAt &&
															` · ${new Date(person.expiresAt).getTime() <= Date.now() ? 'Expired' : `Expires ${new Date(person.expiresAt).toLocaleDateString()}`}`}
													</span>
												</div>
											</div>
											<AccessSelect
												label={`Access for ${person.label}`}
												value={
													person.preset === 'use'
														? 'read'
														: (person.preset ?? 'custom')
												}
												disabled={busy}
												onChange={(next) =>
													void mutate(() =>
														changeFileCollaborator({
															data: {
																orgSlug,
																fileId: item.id,
																subjectType: person.subjectType as
																	| 'org'
																	| 'team'
																	| 'user',
																subjectId: person.subjectId,
																preset: next,
															},
														}),
													)
												}
											/>
											<button
												css={button}
												disabled={busy}
												aria-label={`Remove access for ${person.label}`}
												onClick={() =>
													void mutate(() =>
														changeFileCollaborator({
															data: {
																orgSlug,
																fileId: item.id,
																subjectType: person.subjectType as
																	| 'org'
																	| 'team'
																	| 'user',
																subjectId: person.subjectId,
																preset: 'read',
																remove: true,
																grantId: person.grantId,
															},
														}),
													)
												}
											>
												×
											</button>
											<CustomAccess
												key={person.grantId + person.permissions.join(',')}
												label={person.label}
												permissions={person.permissions}
												disabled={busy}
												onSave={(permissions) =>
													void mutate(() =>
														changeFileCollaborator({
															data: {
																orgSlug,
																fileId: item.id,
																subjectType: person.subjectType as
																	| 'user'
																	| 'team'
																	| 'org',
																subjectId: person.subjectId,
																permissions,
															},
														}),
													)
												}
											/>
										</div>
									))}
									<form
										onSubmit={(event) => {
											event.preventDefault()
											void mutate(async () => {
												if (recipient.includes(':')) {
													const [subjectType, subjectId] = recipient.split(':')
													await changeFileCollaborator({
														data: {
															orgSlug,
															fileId: item.id,
															subjectType: subjectType as
																| 'user'
																| 'team'
																| 'org',
															subjectId: subjectId!,
															preset,
														},
													})
												} else {
													const result = await shareFile({
														data: {
															orgSlug,
															fileId: item.id,
															email: inviteEmail,
															preset,
														},
													})
													if (!result.ok) throw new Error(result.message)
													setInviteLink(result.href)
												}
												setRecipient('')
												setInviteEmail('')
											})
										}}
										css={{ marginTop: 12, display: 'grid', gap: 8 }}
									>
										{recipientOptions.length > 1 && (
											<Combobox
												id="file-permission-recipient"
												label="Person or team"
												hideLabel
												placeholder="Find people or teams"
												value={recipient}
												options={recipientOptions}
												disabled={busy}
												onChange={(value) =>
													setRecipient(value === 'email' ? '' : value)
												}
											/>
										)}
										{!recipient && (
											<input
												aria-label="Collaborator email"
												type="email"
												placeholder="Email address"
												value={inviteEmail}
												disabled={busy}
												onChange={(event) => setInviteEmail(event.target.value)}
												css={accountInputCss}
												required
											/>
										)}
										<div css={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
											<AccessSelect
												label="New collaborator access"
												value={preset}
												disabled={busy}
												onChange={setPreset}
											/>
											<button
												css={{
													...button,
													marginLeft: 'auto',
													background: colors.primarySoft,
												}}
												disabled={busy || (!recipient && !inviteEmail.trim())}
												type="submit"
											>
												{recipient ? 'Add' : 'Create invite'}
											</button>
										</div>
									</form>
									{inviteLink && (
										<div css={{ marginTop: 12 }}>
											<div css={linkField}>
												<input
													aria-label="Invitation link"
													readOnly
													value={new URL(inviteLink, location.origin).href}
													css={linkInput}
												/>
												<button
													css={button}
													onClick={() => void copy(inviteLink)}
												>
													{copied === inviteLink
														? 'Copied'
														: 'Copy invitation link'}
												</button>
											</div>
											<p
												css={{
													margin: '6px 0 0',
													color: colors.textMuted,
													fontSize: 12,
												}}
											>
												Send this link to the invited person. They must accept
												before receiving access.
											</p>
										</div>
									)}
									{data.invites.map((invite) => (
										<div
											key={invite.id}
											css={{
												display: 'flex',
												alignItems: 'center',
												gap: 8,
												paddingTop: 12,
											}}
										>
											<div css={{ flex: 1 }}>
												{invite.invitee_email || invite.invitee_username}
												<div css={{ fontSize: 11, color: colors.textMuted }}>
													Pending invitation
												</div>
											</div>
											<button
												css={button}
												disabled={busy}
												onClick={() =>
													void mutate(() =>
														revokeFileInvitation({
															data: {
																orgSlug,
																fileId: item.id,
																inviteId: invite.id,
															},
														}),
													)
												}
											>
												Revoke
											</button>
										</div>
									))}
								</section>
							)}
							<section aria-label="General access" hidden={tab !== 'sharing'}>
								<h3>General access</h3>
								<select
									aria-label="General access"
									data-field-ring
									disabled={busy || !data.access.manage}
									value={data.file.accessMode ?? 'inherit'}
									css={{ ...getSelectCss(), width: '100%' }}
									onChange={(event) =>
										void mutate(async () => {
											const result = await manageWorkspaceFile({
												data: {
													orgSlug,
													input: {
														file_id: item.id,
														action: 'access',
														access_mode: event.target.value as
															| 'inherit'
															| 'restricted',
														expected_version: data.file.metadataVersion ?? 0,
														operation_id: crypto.randomUUID(),
													},
												},
											})
											if (!result.ok) throw new Error(result.message)
										})
									}
								>
									<option value="inherit">Inherit access</option>
									<option value="restricted">
										Only added people and teams
									</option>
								</select>
								<p>
									{data.file.accessMode === 'restricted'
										? 'Only added people and teams can access this item and its contents.'
										: data.personal
											? data.file.parentId
												? 'Parent access and direct grants apply.'
												: 'Only you and people you add have access.'
											: 'Organization members can view by default. Parent grants also apply.'}{' '}
									{!data.personal &&
										data.file.accessMode === 'restricted' &&
										' Owners retain access.'}
								</p>
								{restrictedParent && (
									<p role="note">
										Access is also limited by{' '}
										<SiteLink
											href={`/@${orgSlug}/-/files?file=${restrictedParent.id}`}
											onClick={onClose}
										>
											{restrictedParent.name}
										</SiteLink>
										. A grant here cannot bypass that folder’s restrictions.
									</p>
								)}
							</section>
							{data.access.manage &&
								data.ancestors.some((parent) => parent.grants.length > 0) && (
									<section
										aria-label="Inherited access"
										hidden={tab !== 'sharing'}
									>
										<h3>Inherited access</h3>
										{data.ancestors
											.filter((parent) => parent.grants.length)
											.map((parent) => (
												<div key={parent.id} css={{ marginTop: 10 }}>
													<SiteLink
														href={`/@${orgSlug}/-/files?file=${parent.id}`}
														onClick={onClose}
													>
														{parent.name}
													</SiteLink>
													<p>
														{parent.grants
															.map(
																(person) =>
																	`${person.label} (${person.preset ?? 'custom'})`,
															)
															.join(', ')}
													</p>
												</div>
											))}
										<p>
											Change inherited access on its source. Restrictions above
											and below still apply.
										</p>
									</section>
								)}
							{data.access.manage && (
								<section
									aria-label="Public link"
									hidden={tab !== 'sharing'}
									css={{
										borderTop: `1px solid ${colors.border}`,
										paddingTop: 20,
									}}
								>
									<h3>Public link</h3>
									<div css={{ display: 'flex', alignItems: 'center', gap: 8 }}>
										<span css={{ flex: 1 }}>
											{restrictedParent
												? 'Blocked by parent'
												: data.publicLinkEnabled
													? 'Anyone with the link'
													: data.publicVia
														? 'Shared by parent'
														: 'Not public'}
										</span>
										<button
											css={button}
											hidden={!!link}
											disabled={busy || !!restrictedParent}
											onClick={() =>
												data.publicLinkEnabled
													? setConfirmRotate(true)
													: void mutate(async () => {
															const result = await setFilePublicLink({
																data: {
																	orgSlug,
																	fileId: item.id,
																	enabled: true,
																},
															})
															setPublicLink(result.href ?? '')
														})
											}
										>
											{data.publicLinkEnabled
												? 'Replace link'
												: 'Create public link'}
										</button>
										{data.publicLinkEnabled && (
											<button
												css={button}
												disabled={busy}
												onClick={() =>
													void mutate(async () => {
														await setFilePublicLink({
															data: {
																orgSlug,
																fileId: item.id,
																enabled: false,
															},
														})
														setPublicLink('')
													})
												}
											>
												Revoke
											</button>
										)}
									</div>
									<p>
										{restrictedParent
											? 'Public access is limited by the parent folder.'
											: 'Visitors can view and download without signing in.'}
										{data.publicLinkEnabled && !link
											? ' Creating a replacement disables the old link.'
											: ''}
									</p>
									{data.publicVia && (
										<p>
											Also accessible through{' '}
											<SiteLink
												href={`/@${orgSlug}/-/files?file=${data.publicVia.id}`}
												onClick={onClose}
											>
												{data.publicVia.name}
											</SiteLink>
											’s public link.
										</p>
									)}
									{link && (
										<div css={linkField}>
											<input
												aria-label="Public link URL"
												readOnly
												value={new URL(link, location.origin).href}
												css={linkInput}
											/>
											<button css={button} onClick={() => void copy(link)}>
												{copied === link ? 'Copied' : 'Copy public link'}
											</button>
										</div>
									)}
									{link && (
										<div
											css={{
												display: 'flex',
												alignItems: 'center',
												gap: 8,
												marginTop: 8,
											}}
										>
											<SiteLink
												href={link}
												target="_blank"
												rel="noreferrer"
												css={button}
											>
												Preview public view ↗
											</SiteLink>
											<ContextMenuSurface
												resolve={() => [
													{
														id: 'replace',
														label: 'Replace public link',
														disabled: busy,
														run: () => setConfirmRotate(true),
													},
												]}
											>
												<ContextMenuButton
													label="Public link settings"
													css={button}
												>
													•••
												</ContextMenuButton>
											</ContextMenuSurface>
										</div>
									)}
									{confirmRotate && (
										<div
											role="group"
											aria-label="Replace public link"
											css={{
												padding: 12,
												background: colors.background,
												borderRadius: 6,
												marginTop: 10,
											}}
										>
											<p>The existing link will stop working.</p>
											<button
												css={button}
												disabled={busy}
												onClick={() =>
													void mutate(async () => {
														const result = await setFilePublicLink({
															data: { orgSlug, fileId: item.id, enabled: true },
														})
														setPublicLink(result.href ?? '')
														setConfirmRotate(false)
													})
												}
											>
												Replace link
											</button>
											<button
												css={button}
												onClick={() => setConfirmRotate(false)}
											>
												Cancel
											</button>
										</div>
									)}
								</section>
							)}
							{data.access.manage &&
								item.mediaType !== workspaceDirectoryMediaType &&
								item.mediaType !== workspacePageMediaType && (
									<section
										aria-label="Asset URLs"
										hidden={tab !== 'sharing'}
										css={{
											borderTop: `1px solid ${colors.border}`,
											paddingTop: 20,
										}}
									>
										<h3>Asset URLs</h3>
										{assetSettings.cacheControl !== 'no-store' && (
											<p css={{ color: colors.textMuted }}>
												Cached copies can remain available until their cache
												expires.
											</p>
										)}
										{publicAssetLink ? (
											<div css={linkField}>
												<input
													css={linkInput}
													aria-label="Public asset URL"
													readOnly
													value={new URL(publicAssetLink, location.origin).href}
												/>
												<button
													css={button}
													onClick={() => void copy(publicAssetLink)}
												>
													{copied === publicAssetLink
														? 'Copied'
														: 'Copy asset URL'}
												</button>
											</div>
										) : (
											<p>Create a public link to get a public asset URL.</p>
										)}
										<form
											css={linkField}
											key={JSON.stringify(assetSettings)}
											onSubmit={(event) => {
												event.preventDefault()
												const form = new FormData(event.currentTarget)
												const cacheControl = assetCacheControls.find(
													(value) => value === form.get('cacheControl'),
												)
												const disposition = form.get('disposition')
												if (
													!cacheControl ||
													(disposition !== 'inline' &&
														disposition !== 'attachment')
												)
													return
												void mutate(() =>
													configureFileAsset({
														data: {
															orgSlug,
															fileId: item.id,
															cacheControl,
															disposition,
														},
													}),
												)
											}}
										>
											<label>
												Public cache lifetime
												<select
													css={getSelectCss()}
													name="cacheControl"
													disabled={busy}
													defaultValue={assetSettings.cacheControl}
												>
													<option value="no-store">Do not cache</option>
													<option value="public, max-age=60">1 minute</option>
													<option value="public, max-age=300">5 minutes</option>
													<option value="public, max-age=3600">1 hour</option>
												</select>
											</label>
											<label>
												Content disposition
												<select
													css={getSelectCss()}
													name="disposition"
													disabled={busy}
													defaultValue={assetSettings.disposition}
												>
													<option value="inline">Display when supported</option>
													<option value="attachment">Download</option>
												</select>
											</label>
											<button css={button} disabled={busy}>
												Save asset settings
											</button>
										</form>
										<form
											css={linkField}
											onSubmit={(event) => {
												event.preventDefault()
												const minutes = Number(
													new FormData(event.currentTarget).get('minutes'),
												)
												void mutate(async () => {
													const result = await createSignedFileAsset({
														data: { orgSlug, fileId: item.id, minutes },
													})
													setSignedAssetLink(result.href)
												})
											}}
										>
											<label>
												Signed URL expires in
												<select
													css={getSelectCss()}
													name="minutes"
													disabled={busy}
													defaultValue="60"
												>
													<option value="15">15 minutes</option>
													<option value="60">1 hour</option>
													<option value="1440">24 hours</option>
												</select>
											</label>
											<button css={button} disabled={busy}>
												Create signed URL
											</button>
										</form>
										{signedAssetLink && (
											<div css={linkField}>
												<input
													css={linkInput}
													aria-label="Signed asset URL"
													readOnly
													value={new URL(signedAssetLink, location.origin).href}
												/>
												<button
													css={button}
													onClick={() => void copy(signedAssetLink)}
												>
													{copied === signedAssetLink
														? 'Copied'
														: 'Copy signed URL'}
												</button>
											</div>
										)}
									</section>
								)}
						</>
					)
				)}
				{error && (
					<p
						role="alert"
						css={{
							color: colors.danger,
							overflowWrap: 'anywhere',
							margin: '12px 0 0',
						}}
					>
						{error}
					</p>
				)}
				{busy && <LoadingIndicator inline label="Saving permissions" />}
			</div>
			<footer
				css={{
					display: 'flex',
					gap: 8,
					justifyContent: 'space-between',
					alignItems: 'center',
					padding: '12px 20px',
					borderTop: `1px solid ${colors.border}`,
					flexShrink: 0,
				}}
			>
				<button
					css={button}
					onClick={() => void copy(`/@${orgSlug}/-/files?file=${item.id}`)}
				>
					{copied === `/@${orgSlug}/-/files?file=${item.id}`
						? 'Copied'
						: 'Copy internal link'}
				</button>
				<button
					css={{
						...button,
						background: colors.primarySoftest,
						color: colors.primaryText,
					}}
					onClick={onClose}
				>
					Done
				</button>
			</footer>
		</ModalDialog>
	)
}
