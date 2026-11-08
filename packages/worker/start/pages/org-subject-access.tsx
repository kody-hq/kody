/** @jsxImportSource @emotion/react */
import type {
	OrgSubjectAccessGrant,
	OrgSubjectAccessLoaderData,
	OrgSubjectAccessOption,
	OrgSubjectAccessWriteResult,
} from '#universal/loader-data.ts'
import { orgGrantsPath, orgIdentity } from '#universal/org-pages.ts'
import type { OrgSubjectAccessItem } from '#universal/org-people-mutations.ts'
import {
	getDangerPillCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import type { QueryKey } from '@tanstack/react-query'
import { useState } from 'react'
import { renderIcon, type IconName } from '../components/icon.tsx'
import { SiteLink } from '../components/site-link.tsx'
import { UserAvatar } from '../components/user-avatar.tsx'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
} from './account-management-components.tsx'
import {
	grantOrganizationSubjectAccess,
	revokeOrganizationGrant,
} from '#start/server/org-mutations'
import { useOrgPeopleMutation } from './org-people-mutation.ts'

type Preset = OrgSubjectAccessItem['preset']
type Message = { tone: 'info' | 'error'; text: string }

const presetChoices: Record<
	OrgSubjectAccessItem['resourceType'],
	ReadonlyArray<{ value: Preset; label: string }>
> = {
	package: [
		{ value: 'read', label: 'Read: see and fork the source' },
		{ value: 'use', label: 'Use: run it' },
		{ value: 'contribute', label: 'Contribute: run and change it' },
		{ value: 'manage', label: 'Manage: also publish, delete, and share' },
	],
	app: [
		{ value: 'use', label: 'Use: open the app' },
		{ value: 'manage', label: 'Manage: also share the app' },
	],
	credential: [
		{ value: 'use', label: 'Use: runs can use it, value stays hidden' },
		{ value: 'contribute', label: 'Contribute: use and update it' },
		{ value: 'manage', label: 'Manage: also delete and share it' },
	],
}

function isEditableType(
	resourceType: string,
): resourceType is OrgSubjectAccessItem['resourceType'] {
	return (
		resourceType === 'package' ||
		resourceType === 'app' ||
		resourceType === 'credential'
	)
}

function subjectLabel(subject: OrgSubjectAccessLoaderData['subject']) {
	return (
		subject.displayName?.trim() ||
		(subject.username ? `@${subject.username}` : subject.userId)
	)
}

function roleNote(
	subject: OrgSubjectAccessLoaderData['subject'],
	orgSlug: string,
) {
	switch (subject.role) {
		case 'owner':
			return `Owner of @${orgSlug}. Owners can use and manage everything in this organization, so there is nothing to grant.`
		case 'member':
			return 'Member. Their role and organization settings can also let them create their own packages and credentials.'
		case 'billing':
			return 'Billing member. They only get what is granted here, plus billing.'
		default:
			return 'Outside collaborator. They are not a member, so only grants made here reach them.'
	}
}

function grantIcon(grant: OrgSubjectAccessGrant): IconName {
	if (grant.via === 'team') return 'users'
	if (grant.via === 'everyone') return 'globe'
	return grant.resourceType === 'credential' ? 'key' : 'box'
}

function resourceKind(resourceType: string) {
	switch (resourceType) {
		case 'package':
			return 'Package'
		case 'app':
			return 'Package app'
		case 'credential':
			return 'Credential'
		case 'org':
			return 'Organization-wide'
		case 'job':
			return 'Job'
		case 'memory':
			return 'Memory'
		case 'email':
			return 'Email'
		default:
			return resourceType
	}
}

function grantDetail(grant: OrgSubjectAccessGrant) {
	const access = grant.presetLabel ?? grant.permissions.join(', ')
	const parts = [resourceKind(grant.resourceType), access || 'No permissions']
	if (grant.via === 'team') parts.push(`Through ${grant.subjectLabel}`)
	if (grant.via === 'everyone') parts.push('Everyone in this organization')
	return parts.join(' · ')
}

function summarize(
	results: ReadonlyArray<OrgSubjectAccessWriteResult>,
	labelFor: (result: OrgSubjectAccessWriteResult) => string,
): Message {
	const saved = results.filter((result) => result.ok)
	const failed = results.flatMap((result) => (result.ok ? [] : [result]))
	const warnings = saved.flatMap((result) => (result.ok ? result.warnings : []))
	const parts: Array<string> = []
	if (saved.length > 0) parts.push(`Saved ${saved.length}.`)
	for (const result of failed) {
		parts.push(`Could not save ${labelFor(result)}: ${result.error}`)
	}
	parts.push(...warnings)
	return { tone: failed.length > 0 ? 'error' : 'info', text: parts.join(' ') }
}

export function OrgSubjectAccessPage(props: {
	data: OrgSubjectAccessLoaderData
	queryKey: QueryKey
}) {
	return (
		<OrgSubjectAccessContent key={JSON.stringify(props.queryKey)} {...props} />
	)
}

function OrgSubjectAccessContent({
	data,
	queryKey,
}: {
	data: OrgSubjectAccessLoaderData
	queryKey: QueryKey
}) {
	const [message, setMessage] = useState<Message | null>(null)
	const label = subjectLabel(data.subject)
	const href = `/@${data.org.slug}/-/grants/user/${encodeURIComponent(data.subject.userId)}`
	const identity = orgIdentity(
		{
			slug: data.subject.username ?? data.subject.userId,
			displayName: data.subject.displayName,
			personal: false,
			avatarUrl: data.subject.avatarUrl,
		},
		{ displayName: '', avatarUrl: null },
	)
	const direct = data.grants.filter((grant) => grant.via === 'direct')
	const packages = direct.filter(
		(grant) => grant.resourceType === 'package' || grant.resourceType === 'app',
	)
	const credentials = direct.filter(
		(grant) => grant.resourceType === 'credential',
	)
	const other = [
		...direct.filter((grant) => !isEditableType(grant.resourceType)),
		...data.grants.filter((grant) => grant.via !== 'direct'),
	]
	const labelFor = (result: OrgSubjectAccessWriteResult) => {
		const known =
			data.grants.find(
				(grant) =>
					grant.resourceId === result.resourceId &&
					grant.resourceType === result.resourceType,
			)?.resourceLabel ??
			[
				...(data.options?.packages ?? []),
				...(data.options?.credentials ?? []),
			].find((option) => option.resourceId === result.resourceId)?.label ??
			result.resourceId
		return result.resourceType === 'app' ? `the ${known} app` : known
	}
	return (
		<AccountManagementShell layout="list" currentHref={href}>
			<AccountPageHeader
				entity="grants"
				title={`Access for ${label}`}
				description={`What ${label} can use in @${data.org.slug}. Grants apply only inside this organization, and credentials stay here.`}
				currentHref={href}
			/>
			<p css={backCss}>
				<SiteLink href={orgGrantsPath(data.org.slug)} data-testid="access-back">
					{renderIcon('arrow-left', { size: '1rem' })}
					All grants
				</SiteLink>
			</p>
			<div css={personCss} data-testid="access-subject">
				<UserAvatar
					displayName={identity.avatarName}
					avatarUrl={data.subject.avatarUrl}
					size={44}
					variant="well"
				/>
				<span css={rowTextCss}>
					<span css={rowNameCss}>{label}</span>
					<span css={rowDetailCss}>
						{roleNote(data.subject, data.org.slug)}
					</span>
				</span>
			</div>
			{message ? (
				<AccountManagementMessage tone={message.tone}>
					{message.text}
				</AccountManagementMessage>
			) : null}
			<GrantSection
				title="Packages"
				testId="access-packages"
				empty={`${label} has no package grants here yet.`}
				grants={packages}
				data={data}
				queryKey={queryKey}
				setMessage={setMessage}
				labelFor={labelFor}
			/>
			<GrantSection
				title="Credentials"
				testId="access-credentials"
				empty={`${label} has no credential grants here yet.`}
				grants={credentials}
				data={data}
				queryKey={queryKey}
				setMessage={setMessage}
				labelFor={labelFor}
			/>
			{other.length > 0 ? (
				<GrantSection
					title="Other access"
					description="Organization-wide grants are changed on the Grants page. Team access is changed on that team."
					testId="access-other"
					empty=""
					grants={other}
					data={data}
					queryKey={queryKey}
					setMessage={setMessage}
					labelFor={labelFor}
				/>
			) : null}
			{data.options ? (
				<AddAccessForm
					data={data}
					options={data.options}
					label={label}
					queryKey={queryKey}
					labelFor={labelFor}
				/>
			) : null}
		</AccountManagementShell>
	)
}

function GrantSection(props: {
	title: string
	description?: string
	testId: string
	empty: string
	grants: ReadonlyArray<OrgSubjectAccessGrant>
	data: OrgSubjectAccessLoaderData
	queryKey: QueryKey
	setMessage: (message: Message | null) => void
	labelFor: (result: OrgSubjectAccessWriteResult) => string
}) {
	return (
		<AccountManagementPanel title={props.title} description={props.description}>
			{props.grants.length === 0 ? (
				<p css={mutedCopyCss} data-testid={`${props.testId}-empty`}>
					{props.empty}
				</p>
			) : (
				<ul css={listCss} data-testid={props.testId}>
					{props.grants.map((grant) => (
						<GrantRow
							key={grant.id}
							grant={grant}
							data={props.data}
							queryKey={props.queryKey}
							setMessage={props.setMessage}
							labelFor={props.labelFor}
						/>
					))}
				</ul>
			)}
		</AccountManagementPanel>
	)
}

function GrantRow({
	grant,
	data,
	queryKey,
	setMessage,
	labelFor,
}: {
	grant: OrgSubjectAccessGrant
	data: OrgSubjectAccessLoaderData
	queryKey: QueryKey
	setMessage: (message: Message | null) => void
	labelFor: (result: OrgSubjectAccessWriteResult) => string
}) {
	const capture = useSubmitterScope()
	const [armed, setArmed] = useState(false)
	const revoke = useOrgPeopleMutation(queryKey, revokeOrganizationGrant)
	const change = useOrgPeopleMutation(queryKey, grantOrganizationSubjectAccess)
	const editable = grant.canRevoke && data.canManage
	const resourceType = grant.resourceType
	const choices = isEditableType(resourceType)
		? presetChoices[resourceType]
		: []
	const pending = revoke.isPending || change.isPending
	return (
		<li
			data-testid="access-grant"
			data-grant-id={grant.id}
			data-via={grant.via}
			css={rowItemCss}
		>
			<div css={rowCss}>
				<span aria-hidden="true" css={iconCss}>
					{renderIcon(grantIcon(grant), { size: '1.25rem' })}
				</span>
				<span css={rowTextCss}>
					<span css={rowNameCss}>{grant.resourceLabel}</span>
					<span css={rowDetailCss}>{grantDetail(grant)}</span>
				</span>
				{editable ? (
					<span css={rowActionsCss}>
						{isEditableType(resourceType) ? (
							<select
								aria-label={`Access to ${grant.resourceLabel}`}
								data-testid="access-grant-preset"
								value={
									change.isPending
										? (change.variables?.items[0]?.preset ?? '')
										: (grant.preset ?? '')
								}
								disabled={pending}
								data-field-ring
								css={selectCss}
								onChange={(event) => {
									const preset = event.currentTarget.value as Preset
									const isCurrent = capture()
									setMessage(null)
									change.mutate(
										{
											orgSlug: data.org.slug,
											userId: data.subject.userId,
											items: [
												{
													resourceType,
													resourceId: grant.resourceId,
													preset,
												},
											],
										},
										{
											onSuccess: (result) => {
												if (isCurrent())
													setMessage(summarize(result.results, labelFor))
											},
											onError: (error) => {
												if (isCurrent())
													setMessage({ tone: 'error', text: error.message })
											},
										},
									)
								}}
							>
								{grant.preset ? null : (
									<option value="" disabled>
										Custom permissions
									</option>
								)}
								{choices.map((choice) => (
									<option key={choice.value} value={choice.value}>
										{choice.label.split(':')[0]}
									</option>
								))}
							</select>
						) : null}
						<button
							type="button"
							data-testid="access-grant-remove"
							css={getDangerPillCss({ size: 'sm' })}
							disabled={pending}
							onBlur={() => setArmed(false)}
							onKeyDown={(event) => {
								if (event.key === 'Escape') setArmed(false)
							}}
							onClick={() => {
								if (!armed) {
									setArmed(true)
									return
								}
								const isCurrent = capture()
								setMessage(null)
								revoke.mutate(
									{ orgSlug: data.org.slug, grantId: grant.id },
									{
										onSuccess: () => {
											if (!isCurrent()) return
											setArmed(false)
											setMessage({
												tone: 'info',
												text: `Removed access to ${grant.resourceLabel}.`,
											})
										},
										onError: (error) => {
											if (isCurrent())
												setMessage({ tone: 'error', text: error.message })
										},
									},
								)
							}}
						>
							{renderIcon('close', { size: '1.05rem' })}
							{armed ? 'Confirm remove' : 'Remove'}
						</button>
					</span>
				) : null}
			</div>
		</li>
	)
}

function AddAccessForm({
	data,
	options,
	label,
	queryKey,
	labelFor,
}: {
	data: OrgSubjectAccessLoaderData
	options: NonNullable<OrgSubjectAccessLoaderData['options']>
	label: string
	queryKey: QueryKey
	labelFor: (result: OrgSubjectAccessWriteResult) => string
}) {
	const capture = useSubmitterScope()
	const mutation = useOrgPeopleMutation(
		queryKey,
		grantOrganizationSubjectAccess,
	)
	const [filter, setFilter] = useState('')
	const [packageIds, setPackageIds] = useState<Array<string>>([])
	const [appIds, setAppIds] = useState<Array<string>>([])
	const [credentialIds, setCredentialIds] = useState<Array<string>>([])
	const [packagePreset, setPackagePreset] = useState<Preset>('use')
	const [credentialPreset, setCredentialPreset] = useState<Preset>('use')
	const [message, setMessage] = useState<Message | null>(null)
	const needle = filter.trim().toLowerCase()
	const matches = (option: OrgSubjectAccessOption) =>
		!needle ||
		option.label.toLowerCase().includes(needle) ||
		(option.detail ?? '').toLowerCase().includes(needle)
	const items: Array<OrgSubjectAccessItem> = [
		...packageIds.map((resourceId) => ({
			resourceType: 'package' as const,
			resourceId,
			preset: packagePreset,
		})),
		...appIds
			.filter((resourceId) => packageIds.includes(resourceId))
			.map((resourceId) => ({
				resourceType: 'app' as const,
				resourceId,
				preset: 'use' as const,
			})),
		...credentialIds.map((resourceId) => ({
			resourceType: 'credential' as const,
			resourceId,
			preset: credentialPreset,
		})),
	]
	const toggle = (
		set: (update: (current: Array<string>) => Array<string>) => void,
		id: string,
	) =>
		set((current) =>
			current.includes(id)
				? current.filter((entry) => entry !== id)
				: [...current, id],
		)
	const nothingToGrant =
		options.packages.length === 0 && options.credentials.length === 0
	return (
		<AccountManagementPanel
			title="Give access"
			description={`Pick the packages and credentials ${label} should be able to use. Each one is its own grant, so you can trim it later.`}
		>
			{nothingToGrant ? (
				<p css={mutedCopyCss} data-testid="access-add-empty">
					There is nothing else here you can share with {label}.
				</p>
			) : (
				<form
					css={formCss}
					data-testid="access-add-form"
					onSubmit={(event) => {
						event.preventDefault()
						if (items.length === 0) return
						const isCurrent = capture()
						setMessage(null)
						mutation.mutate(
							{
								orgSlug: data.org.slug,
								userId: data.subject.userId,
								items,
							},
							{
								onSuccess: (result) => {
									if (!isCurrent()) return
									const saved = new Set(
										result.results.flatMap((entry) =>
											entry.ok
												? [`${entry.resourceType}:${entry.resourceId}`]
												: [],
										),
									)
									setPackageIds((current) =>
										current.filter((id) => !saved.has(`package:${id}`)),
									)
									setAppIds((current) =>
										current.filter((id) => !saved.has(`app:${id}`)),
									)
									setCredentialIds((current) =>
										current.filter((id) => !saved.has(`credential:${id}`)),
									)
									setMessage(summarize(result.results, labelFor))
								},
								onError: (error) => {
									if (isCurrent())
										setMessage({ tone: 'error', text: error.message })
								},
							},
						)
					}}
				>
					<label css={accountFieldCss}>
						<span css={accountFieldLabelCss}>Organization</span>
						<select
							disabled
							value={data.org.slug}
							data-field-ring
							css={selectCss}
						>
							<option value={data.org.slug}>@{data.org.slug}</option>
						</select>
						<span css={accountFieldNoteCss}>
							Access is granted inside @{data.org.slug}. Credentials are not
							moved or copied to another organization.
						</span>
					</label>
					<label css={accountFieldCss}>
						<span css={accountFieldLabelCss}>Filter</span>
						<input
							type="search"
							value={filter}
							placeholder="Search packages and credentials"
							data-testid="access-add-filter"
							css={accountInputCss}
							onChange={(event) => setFilter(event.currentTarget.value)}
						/>
					</label>
					{options.packages.length > 0 ? (
						<fieldset css={fieldsetCss} disabled={mutation.isPending}>
							<legend css={accountFieldLabelCss}>Packages</legend>
							<div css={checkListCss}>
								{options.packages.filter(matches).map((option) => {
									const checked = packageIds.includes(option.resourceId)
									return (
										<div key={option.resourceId} css={checkGroupCss}>
											<label
												css={checkRowCss}
												data-testid="access-add-package"
												data-resource-id={option.resourceId}
											>
												<input
													type="checkbox"
													checked={checked}
													css={checkboxCss}
													onChange={() =>
														toggle(setPackageIds, option.resourceId)
													}
												/>
												<span css={checkTextCss}>
													<span css={checkLabelCss}>{option.label}</span>
													{option.detail &&
													!option.label.includes(option.detail) ? (
														<span css={accountFieldNoteCss}>
															{option.detail}
														</span>
													) : null}
												</span>
											</label>
											{checked && option.appGrantable ? (
												<label
													css={[checkRowCss, nestedCheckCss]}
													data-testid="access-add-app"
												>
													<input
														type="checkbox"
														checked={appIds.includes(option.resourceId)}
														css={checkboxCss}
														onChange={() =>
															toggle(setAppIds, option.resourceId)
														}
													/>
													<span css={checkLabelCss}>
														Also let them open its app
													</span>
												</label>
											) : null}
										</div>
									)
								})}
							</div>
							<label css={accountFieldCss}>
								<span css={accountFieldLabelCss}>Package access</span>
								<select
									value={packagePreset}
									data-testid="access-add-package-preset"
									data-field-ring
									css={selectCss}
									onChange={(event) =>
										setPackagePreset(event.currentTarget.value as Preset)
									}
								>
									{presetChoices.package.map((choice) => (
										<option key={choice.value} value={choice.value}>
											{choice.label}
										</option>
									))}
								</select>
								<span css={accountFieldNoteCss}>
									Packages run with {label}'s own credential access. Add the
									credentials those packages read too.
								</span>
							</label>
						</fieldset>
					) : null}
					{options.credentials.length > 0 ? (
						<fieldset css={fieldsetCss} disabled={mutation.isPending}>
							<legend css={accountFieldLabelCss}>Credentials</legend>
							<div css={checkListCss}>
								{options.credentials.filter(matches).map((option) => (
									<label
										key={option.resourceId}
										css={checkRowCss}
										data-testid="access-add-credential"
										data-resource-id={option.resourceId}
									>
										<input
											type="checkbox"
											checked={credentialIds.includes(option.resourceId)}
											css={checkboxCss}
											onChange={() =>
												toggle(setCredentialIds, option.resourceId)
											}
										/>
										<span css={checkTextCss}>
											<span css={checkLabelCss}>{option.label}</span>
											{option.detail &&
											!option.label.includes(option.detail) ? (
												<span css={accountFieldNoteCss}>{option.detail}</span>
											) : null}
										</span>
									</label>
								))}
							</div>
							<label css={accountFieldCss}>
								<span css={accountFieldLabelCss}>Credential access</span>
								<select
									value={credentialPreset}
									data-testid="access-add-credential-preset"
									data-field-ring
									css={selectCss}
									onChange={(event) =>
										setCredentialPreset(event.currentTarget.value as Preset)
									}
								>
									{presetChoices.credential.map((choice) => (
										<option key={choice.value} value={choice.value}>
											{choice.label}
										</option>
									))}
								</select>
							</label>
						</fieldset>
					) : null}
					{message ? (
						<AccountManagementMessage tone={message.tone}>
							{message.text}
						</AccountManagementMessage>
					) : null}
					<div css={accountActionsCss}>
						<button
							type="submit"
							data-testid="access-add-save"
							disabled={items.length === 0 || mutation.isPending}
							css={getPillButtonCss({ size: 'sm' })}
						>
							{renderIcon('plus', { size: '1.05rem' })}
							{mutation.isPending
								? 'Saving…'
								: items.length > 0
									? `Give access to ${items.length}`
									: 'Give access'}
						</button>
					</div>
				</form>
			)}
		</AccountManagementPanel>
	)
}

const mutedCopyCss = {
	margin: 0,
	color: colors.textMuted,
	lineHeight: 1.5,
}

const backCss = {
	margin: 0,
	'& a': {
		display: 'inline-flex',
		alignItems: 'center',
		gap: spacing.xs,
		fontWeight: 600,
	},
}

const personCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.md,
	minWidth: 0,
}

const listCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.sm,
}

const rowItemCss = {
	minWidth: 0,
}

const rowCss = {
	display: 'flex',
	alignItems: 'center',
	flexWrap: 'wrap' as const,
	gap: spacing.md,
	minWidth: 0,
	padding: '0.85rem 1rem',
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
}

const rowTextCss = {
	display: 'grid',
	gap: '0.15rem',
	minWidth: 0,
	flex: '1 1 12rem',
}

const rowNameCss = {
	fontWeight: 650,
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
}

const rowDetailCss = {
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
}

const rowActionsCss = {
	display: 'flex',
	alignItems: 'center',
	gap: spacing.sm,
	flexShrink: 0,
}

const iconCss = {
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	width: '2.75rem',
	height: '2.75rem',
	borderRadius: radius.full,
	color: colors.textMuted,
	backgroundColor: colors.background,
	flexShrink: 0,
}

const formCss = {
	display: 'grid',
	gap: spacing.lg,
}

const selectCss = {
	...accountInputCss,
	padding: '0.55rem 0.7rem',
}

const fieldsetCss = {
	border: 0,
	margin: 0,
	padding: 0,
	minWidth: 0,
	display: 'grid',
	gap: spacing.sm,
	'&:disabled': { opacity: 0.6 },
}

const checkListCss = {
	display: 'grid',
	gap: spacing.sm,
	maxHeight: '22rem',
	overflowY: 'auto' as const,
}

const checkGroupCss = {
	display: 'grid',
	gap: spacing.xs,
}

const checkRowCss = {
	display: 'flex',
	alignItems: 'flex-start',
	gap: spacing.sm,
	padding: '0.7rem 0.9rem',
	borderRadius: radius.card,
	border: `1.5px solid ${colors.border}`,
	backgroundColor: colors.surface,
	cursor: 'pointer',
	'&:has(input:checked)': {
		borderColor: colors.primary,
		backgroundColor: colors.primarySoftest,
	},
}

const nestedCheckCss = {
	marginLeft: spacing.lg,
}

const checkboxCss = {
	marginTop: '0.2rem',
	accentColor: colors.primary,
	flexShrink: 0,
}

const checkTextCss = {
	display: 'grid',
	gap: '0.15rem',
	minWidth: 0,
}

const checkLabelCss = {
	fontWeight: 600,
}
