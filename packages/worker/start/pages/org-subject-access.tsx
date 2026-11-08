/** @jsxImportSource @emotion/react */
import type {
	OrgGrantRevokeResult,
	OrgSubjectAccessGrant,
	OrgSubjectAccessLoaderData,
	OrgSubjectAccessOption,
	OrgSubjectAccessWriteResult,
} from '#universal/loader-data.ts'
import {
	orgEveryoneGrantAccessPath,
	orgGrantAccessPath,
	orgGrantsPath,
	orgIdentity,
	orgTeamGrantAccessPath,
} from '#universal/org-pages.ts'
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
import type { RowSelectionState } from '@tanstack/react-table'
import { useMemo, useState } from 'react'
import { renderIcon } from '../components/icon.tsx'
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
	revokeOrganizationGrants,
} from '#start/server/org-mutations'
import {
	grantAccessSummary,
	orgPermissionGroups,
	resourceFilterType,
	resourceTypeLabel,
} from './org-grant-summary.ts'
import { useOrgPeopleMutation } from './org-people-mutation.ts'
import {
	RecordTable,
	RecordTableSearch,
	RecordTableSelect,
	type RecordTableColumn,
	type RecordTableRow,
} from './record-table.tsx'

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

type AccessSubject = OrgSubjectAccessLoaderData['subject']

function subjectLabel(subject: AccessSubject) {
	if (subject.kind === 'team') return subject.name
	if (subject.kind === 'org') return 'Everyone in this organization'
	return (
		subject.displayName?.trim() ||
		(subject.username ? `@${subject.username}` : subject.userId)
	)
}

/** `user:<id>`, `team:<id>`, or `org`, as the grant mutation takes it. */
function subjectKey(subject: AccessSubject) {
	if (subject.kind === 'team') return `team:${subject.teamId}`
	if (subject.kind === 'org') return 'org'
	return `user:${subject.userId}`
}

function subjectHref(subject: AccessSubject, orgSlug: string) {
	if (subject.kind === 'team')
		return orgTeamGrantAccessPath(orgSlug, subject.teamId)
	if (subject.kind === 'org') return orgEveryoneGrantAccessPath(orgSlug)
	return orgGrantAccessPath(orgSlug, subject.userId)
}

function memberCountLabel(count: number) {
	return `${count} ${count === 1 ? 'member' : 'members'}`
}

function subjectNote(subject: AccessSubject, orgSlug: string) {
	if (subject.kind === 'team') {
		return `Team @${subject.slug} · ${memberCountLabel(subject.memberCount)}. Everyone on the team gets these grants, plus what everyone in the organization has.`
	}
	if (subject.kind === 'org') {
		return `${memberCountLabel(subject.memberCount)}. Every member of @${orgSlug} gets these grants, now and when they join. Outside collaborators do not.`
	}
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

const typeGroups = [
	{ value: 'org', label: 'Organization permissions' },
	{ value: 'package', label: 'Packages' },
	{ value: 'app', label: 'Package apps' },
	{ value: 'credential', label: 'Credentials' },
	{ value: 'other', label: 'Other resources' },
] as const

function typeGroup(resourceType: string) {
	return resourceFilterType(resourceType)
}

function typeGroupLabel(resourceType: string) {
	const group = typeGroup(resourceType)
	return typeGroups.find((entry) => entry.value === group)?.label ?? group
}

function sortByGroup(grants: ReadonlyArray<OrgSubjectAccessGrant>) {
	const order: ReadonlyArray<string> = typeGroups.map((group) => group.value)
	return [...grants].sort(
		(a, b) =>
			order.indexOf(typeGroup(a.resourceType)) -
				order.indexOf(typeGroup(b.resourceType)) ||
			a.resourceLabel.localeCompare(b.resourceLabel),
	)
}

function viaLabel(grant: OrgSubjectAccessGrant) {
	if (grant.via === 'team') return `Through ${grant.subjectLabel}`
	if (grant.via === 'everyone') return 'Everyone in this organization'
	return 'Direct'
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
	const subject = data.subject
	const label = subjectLabel(subject)
	const href = subjectHref(subject, data.org.slug)
	const direct = sortByGroup(
		data.grants.filter((grant) => grant.via === 'direct'),
	)
	const inherited = sortByGroup(
		data.grants.filter((grant) => grant.via !== 'direct'),
	)
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
	const title =
		subject.kind === 'org' ? 'Access for everyone' : `Access for ${label}`
	return (
		<AccountManagementShell layout="list" currentHref={href}>
			<AccountPageHeader
				entity="grants"
				title={title}
				description={`What ${subject.kind === 'org' ? 'every member' : label} can use in @${data.org.slug}. Grants apply only inside this organization, and credentials stay here.`}
				currentHref={href}
			/>
			<p css={backCss}>
				<SiteLink href={orgGrantsPath(data.org.slug)} data-testid="access-back">
					{renderIcon('arrow-left', { size: '1rem' })}
					All grants
				</SiteLink>
			</p>
			<div
				css={personCss}
				data-testid="access-subject"
				data-subject-kind={subject.kind}
			>
				{subject.kind === 'user' ? (
					<UserAvatar
						displayName={
							orgIdentity(
								{
									slug: subject.username ?? subject.userId,
									displayName: subject.displayName,
									personal: false,
									avatarUrl: subject.avatarUrl,
								},
								{ displayName: '', avatarUrl: null },
							).avatarName
						}
						avatarUrl={subject.avatarUrl}
						size={44}
						variant="well"
					/>
				) : (
					<span aria-hidden="true" css={iconCss}>
						{renderIcon(subject.kind === 'team' ? 'users' : 'globe', {
							size: '1.25rem',
						})}
					</span>
				)}
				<span css={rowTextCss}>
					<span css={rowNameCss}>{label}</span>
					<span css={rowDetailCss}>{subjectNote(subject, data.org.slug)}</span>
				</span>
			</div>
			{message ? (
				<AccountManagementMessage tone={message.tone}>
					{message.text}
				</AccountManagementMessage>
			) : null}
			<AccountManagementPanel
				title="Grants"
				description={
					subject.kind === 'org'
						? 'Grouped by resource type. Select rows to remove several at once.'
						: `Made to ${label} directly, grouped by resource type. Select rows to remove several at once.`
				}
				ariaLabel="Grants"
			>
				<AccessGrantTable
					testId="access-direct"
					ariaLabel={`Grants for ${label}`}
					emptyLabel={`${label} has no grants here yet.`}
					grants={direct}
					data={data}
					queryKey={queryKey}
					setMessage={setMessage}
					labelFor={labelFor}
				/>
			</AccountManagementPanel>
			{inherited.length > 0 ? (
				<AccountManagementPanel
					title={
						subject.kind === 'team'
							? 'From everyone in the organization'
							: 'Through teams and the organization'
					}
					description="Read-only here. Change these on the team or on everyone in the organization."
					ariaLabel="Inherited access"
				>
					<AccessGrantTable
						testId="access-inherited"
						ariaLabel={`Inherited access for ${label}`}
						emptyLabel=""
						grants={inherited}
						data={data}
						queryKey={queryKey}
						setMessage={setMessage}
						labelFor={labelFor}
					/>
				</AccountManagementPanel>
			) : null}
			{data.options ? (
				<AddAccessForm
					data={data}
					options={data.options}
					label={subject.kind === 'org' ? 'every member' : label}
					queryKey={queryKey}
					labelFor={labelFor}
				/>
			) : null}
		</AccountManagementShell>
	)
}

const accessPageSize = 25

function accessColumns(inherited: boolean): Array<RecordTableColumn> {
	return [
		// Group headings already name each type, so the filter rides on the
		// resource column instead of a Type column a phone has no room for.
		{
			key: 'resource',
			label: 'Resource',
			primary: true,
			filter: (_value, filter, row) => row.values?.type === filter,
		},
		{ key: 'access', label: 'Access', sortable: false },
		inherited
			? { key: 'via', label: 'From', sortable: false }
			: {
					key: 'actions',
					label: 'Actions',
					sortable: false,
					searchable: false,
				},
	]
}

function AccessGrantTable(props: {
	testId: string
	ariaLabel: string
	emptyLabel: string
	grants: ReadonlyArray<OrgSubjectAccessGrant>
	data: OrgSubjectAccessLoaderData
	queryKey: QueryKey
	setMessage: (message: Message | null) => void
	labelFor: (result: OrgSubjectAccessWriteResult) => string
}) {
	const { data, setMessage } = props
	const inherited = props.testId === 'access-inherited'
	const capture = useSubmitterScope()
	const [query, setQuery] = useState('')
	const [type, setType] = useState('')
	const [page, setPage] = useState(0)
	const [selection, setSelection] = useState<RowSelectionState>({})
	const [armed, setArmed] = useState(false)
	const bulk = useOrgPeopleMutation(props.queryKey, revokeOrganizationGrants)
	const columns = useMemo(() => accessColumns(inherited), [inherited])
	const types = new Set(
		props.grants.map((grant) => typeGroup(grant.resourceType)),
	)
	const rows: Array<RecordTableRow> = props.grants.map((grant) => ({
		id: grant.id,
		selectionLabel: grant.resourceLabel,
		values: {
			resource: `${grant.resourceLabel} ${resourceTypeLabel(grant.resourceType)}`,
			type: typeGroup(grant.resourceType),
			access: grantAccessSummary(grant),
			via: viaLabel(grant),
			canRevoke: grant.canRevoke && data.canManage,
		},
		cells: {
			resource: (
				<span
					css={cellTextCss}
					data-testid="access-grant"
					data-grant-id={grant.id}
					data-via={grant.via}
				>
					<span css={cellNameCss}>{grant.resourceLabel}</span>
					<span css={rowDetailCss}>
						{resourceTypeLabel(grant.resourceType)}
					</span>
				</span>
			),
			access: <GrantAccessCell grant={grant} {...props} />,
			via: viaLabel(grant),
			actions:
				grant.canRevoke && data.canManage ? (
					<RemoveGrantButton grant={grant} {...props} />
				) : null,
		},
	}))
	if (props.grants.length === 0) {
		return (
			<p css={mutedCopyCss} data-testid={`${props.testId}-empty`}>
				{props.emptyLabel}
			</p>
		)
	}
	const filtered = Boolean(query || type)
	const canBulk = !inherited && data.canManage
	return (
		<div data-testid={props.testId} css={accessTableCss}>
			<RecordTable
				mode="none"
				dense
				stackWhenNarrow
				ariaLabel={props.ariaLabel}
				columns={columns}
				rows={rows}
				rowGroup={(row) => typeGroupLabel(String(row.values?.type ?? ''))}
				emptyLabel="No grants match these filters."
				dataControls={{
					state: {
						globalFilter: query.trim(),
						columnFilters: type ? [{ id: 'resource', value: type }] : [],
						sorting: [],
						pagination: { pageIndex: page, pageSize: accessPageSize },
					},
					onStateChange: (patch) => {
						if (patch.pagination) setPage(patch.pagination.pageIndex)
					},
					selection: canBulk
						? {
								value: selection,
								onChange: (value) => {
									setSelection(value)
									setArmed(false)
								},
								canSelect: (row) => row.values?.canRevoke === true,
								actions: (_selected, selectedIds) => (
									<button
										type="button"
										data-testid="access-bulk-remove"
										css={getDangerPillCss({ size: 'sm' })}
										disabled={bulk.isPending}
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
											bulk.mutate(
												{ orgSlug: data.org.slug, grantIds: selectedIds },
												{
													onSuccess: (result) => {
														if (!isCurrent()) return
														setArmed(false)
														setSelection({})
														setMessage(
															revokeSummary(result.results, props.grants),
														)
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
										{armed
											? `Confirm remove ${selectedIds.length}`
											: 'Remove selected'}
									</button>
								),
							}
						: undefined,
				}}
				toolbar={
					<>
						<RecordTableSearch
							label="Search grants"
							placeholder="Search resources"
							value={query}
							onInput={(value) => {
								setQuery(value)
								setPage(0)
							}}
						/>
						{types.size > 1 ? (
							<RecordTableSelect
								label="Filter by resource type"
								value={type}
								onChange={(value) => {
									setType(value)
									setPage(0)
								}}
							>
								<option value="">All resources</option>
								{typeGroups
									.filter((group) => types.has(group.value))
									.map((group) => (
										<option key={group.value} value={group.value}>
											{group.label}
										</option>
									))}
							</RecordTableSelect>
						) : null}
						{filtered ? (
							<button
								type="button"
								onClick={() => {
									setQuery('')
									setType('')
									setPage(0)
								}}
							>
								Clear filters
							</button>
						) : null}
					</>
				}
			/>
		</div>
	)
}

function revokeSummary(
	results: ReadonlyArray<OrgGrantRevokeResult>,
	grants: ReadonlyArray<OrgSubjectAccessGrant>,
): Message {
	const removed = results.filter((result) => result.ok).length
	const failed = results.flatMap((result) => (result.ok ? [] : [result]))
	const parts = removed > 0 ? [`Removed ${removed}.`] : []
	for (const result of failed) {
		const name =
			grants.find((grant) => grant.id === result.grantId)?.resourceLabel ??
			result.grantId
		parts.push(`Could not remove ${name}: ${result.error}`)
	}
	return { tone: failed.length > 0 ? 'error' : 'info', text: parts.join(' ') }
}

/**
 * A preset grant gets a select to change it; an explicit permission list
 * stays one short line, with every permission one click away.
 */
function GrantAccessCell({
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
	const change = useOrgPeopleMutation(queryKey, grantOrganizationSubjectAccess)
	const resourceType = grant.resourceType
	if (
		grant.via === 'direct' &&
		grant.canRevoke &&
		data.canManage &&
		isEditableType(resourceType)
	) {
		return (
			<select
				aria-label={`Access to ${grant.resourceLabel}`}
				data-testid="access-grant-preset"
				value={
					change.isPending
						? (change.variables?.items[0]?.preset ?? '')
						: (grant.preset ?? '')
				}
				disabled={change.isPending}
				data-field-ring
				css={selectCss}
				onChange={(event) => {
					const preset = event.currentTarget.value as Preset
					const isCurrent = capture()
					setMessage(null)
					change.mutate(
						{
							orgSlug: data.org.slug,
							subject: subjectKey(data.subject),
							items: [{ resourceType, resourceId: grant.resourceId, preset }],
						},
						{
							onSuccess: (result) => {
								if (isCurrent()) setMessage(summarize(result.results, labelFor))
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
				{presetChoices[resourceType].map((choice) => (
					<option key={choice.value} value={choice.value}>
						{choice.label.split(':')[0]}
					</option>
				))}
			</select>
		)
	}
	const groups =
		grant.presetLabel || grant.permissions.length === 0
			? []
			: grant.resourceType === 'org'
				? orgPermissionGroups(grant.permissions)
				: [{ label: 'Permissions', items: [...grant.permissions] }]
	const summary = grantAccessSummary(grant)
	if (groups.length === 0) return <span>{summary}</span>
	return (
		<details css={permissionDetailsCss} data-testid="access-grant-permissions">
			<summary>{summary}</summary>
			<dl css={permissionListCss}>
				{groups.map((group) => (
					<div key={group.label}>
						<dt>{group.label}</dt>
						<dd>{group.items.join(', ')}</dd>
					</div>
				))}
			</dl>
		</details>
	)
}

function RemoveGrantButton({
	grant,
	data,
	queryKey,
	setMessage,
}: {
	grant: OrgSubjectAccessGrant
	data: OrgSubjectAccessLoaderData
	queryKey: QueryKey
	setMessage: (message: Message | null) => void
}) {
	const capture = useSubmitterScope()
	const [armed, setArmed] = useState(false)
	const revoke = useOrgPeopleMutation(queryKey, revokeOrganizationGrant)
	return (
		<button
			type="button"
			data-testid="access-grant-remove"
			aria-label={`${armed ? 'Confirm remove' : 'Remove'} ${grant.resourceLabel}`}
			css={getDangerPillCss({ size: 'sm' })}
			disabled={revoke.isPending}
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
			{armed ? 'Confirm' : 'Remove'}
		</button>
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
								subject: subjectKey(data.subject),
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

/** Phone cards: name on top, then access with Remove beside it. */
const accessTableCss = {
	'@container (max-width: 620px)': {
		'& tbody tr:has(> td[data-primary])': {
			gridTemplateColumns: 'auto minmax(0, 1fr) auto',
		},
		'& td[data-primary], & td[data-label="From"]': { gridColumn: '2 / -1' },
		'& td[data-label="Actions"]': { gridColumn: 3, gridRow: 2 },
		'& td[data-label="Access"]::before, & td[data-label="Actions"]::before': {
			content: 'none',
		},
	},
} as const

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

const cellTextCss = {
	display: 'grid',
	gap: '0.1rem',
	minWidth: 0,
}

const cellNameCss = {
	fontWeight: 650,
	overflowWrap: 'anywhere' as const,
}

const permissionDetailsCss = {
	minWidth: 0,
	'& > summary': {
		cursor: 'pointer',
		overflowWrap: 'anywhere' as const,
	},
}

const permissionListCss = {
	display: 'grid',
	gap: spacing.xs,
	margin: `${spacing.xs} 0 0`,
	fontSize: typography.fontSize.sm,
	'& dt': { fontWeight: 650 },
	'& dd': {
		margin: 0,
		color: colors.textMuted,
		overflowWrap: 'anywhere' as const,
	},
}

const rowDetailCss = {
	fontSize: typography.fontSize.sm,
	color: colors.textMuted,
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
