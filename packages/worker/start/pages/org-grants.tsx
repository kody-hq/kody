/** @jsxImportSource @emotion/react */
import type {
	OrgGrantsLoaderData,
	OrgGrantView,
} from '#universal/loader-data.ts'
import {
	orgCollaboratorsPath,
	orgGrantAccessPath,
	orgRoleLabel,
	orgTeamsPath,
} from '#universal/org-pages.ts'
import {
	orgWideReadAccessLabel,
	orgWideReadAccessOptions,
} from '#universal/org-wide-read-access.ts'
import {
	orgCreateAccessLabel,
	orgCreateAccessOptions,
} from '#universal/org-create-access.ts'
import {
	heldOrgWideManageOptions,
	orgWideManageAccessLabel,
	orgWideManageAccessOptions,
	orgWideManagePermissionsFor,
} from '#universal/org-wide-manage-access.ts'
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
import type { OrgRole } from '@kody-internal/shared/request-context.ts'
import type { QueryKey } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { renderIcon } from '../components/icon.tsx'
import { SiteLink } from '../components/site-link.tsx'
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
	grantOrganizationCreateAccess,
	grantOrganizationManageAccess,
	grantOrganizationReadAccess,
	revokeOrganizationGrant,
} from '#start/server/org-mutations'
import { useOrgPeopleMutation } from './org-people-mutation.ts'
import {
	RecordTable,
	RecordTableSearch,
	RecordTableSelect,
	type RecordTableColumn,
	type RecordTableRow,
} from './record-table.tsx'
function grantSummary(grant: OrgGrantView) {
	if (grant.resourceType === 'org') {
		return `${grant.subjectLabel} · Organization-wide access`
	}
	const access = grant.presetLabel ?? 'Custom permissions'
	return `${grant.subjectLabel} · ${access} on ${grant.resourceLabel}`
}

function grantDetail(grant: OrgGrantView) {
	if (grant.preset) return resourceTypeLabel(grant.resourceType)
	const reads = grant.permissions.flatMap(
		(permission) => orgWideReadAccessLabel(permission) ?? [],
	)
	const creates = grant.permissions.flatMap(
		(permission) => orgCreateAccessLabel(permission) ?? [],
	)
	const manages = orgWideManageAccessOptions
		.filter((option) =>
			heldOrgWideManageOptions(grant.permissions).includes(option.permission),
		)
		.map((option) => option.label)
	const other = grant.permissions.filter(
		(permission) =>
			!orgWideReadAccessLabel(permission) &&
			!orgCreateAccessLabel(permission) &&
			!(
				orgWideManageAccessLabel(permission) &&
				manages.includes(orgWideManageAccessLabel(permission) ?? '')
			),
	)
	const parts = [
		...(manages.length > 0 ? [`Manage: ${manages.join(', ')}`] : []),
		...(creates.length > 0 ? [`Create: ${creates.join(', ')}`] : []),
		...(reads.length > 0 ? [`Read: ${reads.join(', ')}`] : []),
		...other,
	]
	return `${resourceTypeLabel(grant.resourceType)} · ${parts.join(', ') || 'no permissions'}`
}

function resourceTypeLabel(resourceType: string) {
	switch (resourceType) {
		case 'org':
			return 'Organization'
		case 'package':
			return 'Package'
		case 'app':
			return 'Package app'
		case 'job':
			return 'Job'
		case 'credential':
			return 'Credential'
		case 'memory':
			return 'Memory'
		case 'email':
			return 'Email'
		case 'execution_context':
			return 'Execution context'
		default:
			return resourceType
	}
}

export function OrgGrantsPage(props: {
	data: OrgGrantsLoaderData
	queryKey: QueryKey
}) {
	return <OrgGrantsContent key={JSON.stringify(props.queryKey)} {...props} />
}

const resourceTypeNouns: Record<string, [string, string]> = {
	package: ['package', 'packages'],
	app: ['app', 'apps'],
	credential: ['credential', 'credentials'],
	org: ['organization-wide grant', 'organization-wide grants'],
	job: ['job', 'jobs'],
	memory: ['memory', 'memories'],
	email: ['email inbox', 'email inboxes'],
	execution_context: ['execution context', 'execution contexts'],
}

const resourceTypeOrder = Object.keys(resourceTypeNouns)

/** "3 packages, 2 credentials" for one subject's direct grants. */
function grantCountsSummary(grants: ReadonlyArray<OrgGrantView>) {
	const counts = new Map<string, number>()
	for (const grant of grants) {
		const type =
			grant.resourceType in resourceTypeNouns ? grant.resourceType : 'other'
		counts.set(type, (counts.get(type) ?? 0) + 1)
	}
	return [...counts.entries()]
		.sort(
			([a], [b]) =>
				(resourceTypeOrder.indexOf(a) >>> 0) -
				(resourceTypeOrder.indexOf(b) >>> 0),
		)
		.map(([type, count]) => {
			const [one, many] = resourceTypeNouns[type] ?? [
				'other grant',
				'other grants',
			]
			return `${count} ${count === 1 ? one : many}`
		})
		.join(', ')
}

type GrantSubjectKind = 'member' | 'collaborator' | 'team' | 'everyone'

const subjectKindFilters: Array<{
	value: '' | GrantSubjectKind
	label: string
}> = [
	{ value: '', label: 'Everyone listed' },
	{ value: 'member', label: 'Members' },
	{ value: 'collaborator', label: 'Outside collaborators' },
	{ value: 'team', label: 'Teams' },
	{ value: 'everyone', label: 'Whole organization' },
]

const resourceTypeFilters = [
	{ value: '', label: 'All resources' },
	{ value: 'package', label: 'Packages' },
	{ value: 'app', label: 'Package apps' },
	{ value: 'credential', label: 'Credentials' },
	{ value: 'org', label: 'Organization-wide' },
	{ value: 'other', label: 'Other resources' },
]

function grantedTypes(grants: ReadonlyArray<OrgGrantView>) {
	return [
		...new Set(
			grants.map((grant) =>
				grant.resourceType in resourceTypeNouns &&
				['package', 'app', 'credential', 'org'].includes(grant.resourceType)
					? grant.resourceType
					: 'other',
			),
		),
	].join(' ')
}

const peopleColumns: Array<RecordTableColumn> = [
	{ key: 'name', label: 'Who', primary: true },
	{
		key: 'role',
		label: 'Role',
		filter: (_value, filter, row) => row.values?.kind === filter,
	},
	{
		key: 'access',
		label: 'Direct access',
		sortable: false,
		filter: (_value, filter, row) =>
			String(row.values?.types ?? '')
				.split(' ')
				.includes(String(filter)),
	},
]

const orgGrantsPageSize = 25

/** Owners and Admins hold access through their role, not through grants. */
function roleAccessSummary(role: OrgRole | null) {
	if (role === 'owner') return 'Full access'
	if (role === 'admin') {
		return 'Full access except deleting the organization or changing Owners'
	}
	return null
}

function OrgGrantsPeopleTable({ data }: { data: OrgGrantsLoaderData }) {
	const [query, setQuery] = useState('')
	const [kind, setKind] = useState<'' | GrantSubjectKind>('')
	const [type, setType] = useState('')
	const [page, setPage] = useState(0)
	const rows = useMemo<Array<RecordTableRow>>(() => {
		const byUser = new Map<string, Array<OrgGrantView>>()
		const byTeam = new Map<string, Array<OrgGrantView>>()
		const everyone: Array<OrgGrantView> = []
		for (const grant of data.grants) {
			if (grant.subjectType === 'org') everyone.push(grant)
			else {
				const map = grant.subjectType === 'team' ? byTeam : byUser
				map.set(grant.subjectId, [...(map.get(grant.subjectId) ?? []), grant])
			}
		}
		const subjects = [...data.subjects]
		for (const [userId, grants] of byUser) {
			if (subjects.some((subject) => subject.userId === userId)) continue
			subjects.push({
				userId,
				label: grants[0]?.subjectLabel ?? userId,
				kind: 'collaborator',
				role: null,
			})
		}
		const row = (input: {
			id: string
			name: string
			kind: GrantSubjectKind
			role: string
			access: string
			grants: ReadonlyArray<OrgGrantView>
			href?: string
		}): RecordTableRow => ({
			id: input.id,
			href: input.href,
			values: {
				name: input.name,
				kind: input.kind,
				role: input.role,
				access: input.access,
				types: grantedTypes(input.grants),
			},
			cells: {
				name: input.name,
				role: input.role,
				access: (
					<span data-testid="org-grant-person-summary">{input.access}</span>
				),
			},
		})
		return [
			...subjects.map((subject) => {
				const grants = byUser.get(subject.userId) ?? []
				const roleSummary = roleAccessSummary(subject.role)
				return row({
					id: `user:${subject.userId}`,
					name: subject.label,
					kind: subject.kind,
					role: orgRoleLabel(subject.role),
					access:
						roleSummary ?? (grantCountsSummary(grants) || 'No direct grants'),
					grants,
					href: roleSummary
						? undefined
						: orgGrantAccessPath(data.org.slug, subject.userId),
				})
			}),
			...[...byTeam.values()].map((grants) =>
				row({
					id: `team:${grants[0]!.subjectId}`,
					name: grants[0]!.subjectLabel,
					kind: 'team',
					role: 'Team',
					access: grantCountsSummary(grants),
					grants,
					href: orgTeamsPath(data.org.slug),
				}),
			),
			...(everyone.length > 0
				? [
						row({
							id: 'org',
							name: 'Everyone in this organization',
							kind: 'everyone',
							role: 'Everyone',
							access: grantCountsSummary(everyone),
							grants: everyone,
						}),
					]
				: []),
		]
	}, [data])
	const filtered = Boolean(query || kind || type)
	return (
		<AccountManagementPanel
			title="People with access"
			ariaLabel="People with access"
		>
			<RecordTable
				mode="none"
				dense
				ariaLabel="People with access"
				columns={peopleColumns}
				rows={rows}
				emptyLabel={
					rows.length > 0
						? 'No one matches these filters.'
						: 'No grants yet. Use Give someone access above, or invite someone to a package.'
				}
				dataControls={{
					state: {
						globalFilter: query.trim(),
						columnFilters: [
							...(kind ? [{ id: 'role', value: kind }] : []),
							...(type ? [{ id: 'access', value: type }] : []),
						],
						sorting: [],
						pagination: { pageIndex: page, pageSize: orgGrantsPageSize },
					},
					onStateChange: (patch) => {
						if (patch.pagination) setPage(patch.pagination.pageIndex)
					},
				}}
				toolbar={
					<>
						<RecordTableSearch
							label="Search people"
							placeholder="Search people or teams"
							value={query}
							onInput={(value) => {
								setQuery(value)
								setPage(0)
							}}
						/>
						<RecordTableSelect
							label="Filter by person"
							value={kind}
							onChange={(value) => {
								setKind(value as '' | GrantSubjectKind)
								setPage(0)
							}}
						>
							{subjectKindFilters.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</RecordTableSelect>
						<RecordTableSelect
							label="Filter by resource type"
							value={type}
							onChange={(value) => {
								setType(value)
								setPage(0)
							}}
						>
							{resourceTypeFilters.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</RecordTableSelect>
						{filtered ? (
							<button
								type="button"
								onClick={() => {
									setQuery('')
									setKind('')
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
		</AccountManagementPanel>
	)
}

function OrgGrantsContent({
	data,
	queryKey,
}: {
	data: OrgGrantsLoaderData
	queryKey: QueryKey
}) {
	const capture = useSubmitterScope()
	const [armed, setArmed] = useState<string | null>(null)
	const [message, setMessage] = useState<{
		tone: 'info' | 'error'
		text: string
	} | null>(null)
	const mutation = useOrgPeopleMutation(queryKey, revokeOrganizationGrant)
	const sharedGrants = data.grants.filter(
		(grant) => grant.subjectType !== 'user',
	)
	return (
		<AccountManagementShell
			layout="list"
			currentHref={`/@${data.org.slug}/-/grants`}
		>
			<AccountPageHeader
				entity="grants"
				title="Grants"
				description="Who can use packages and other resources in this organization."
				currentHref={`/@${data.org.slug}/-/grants`}
			/>
			{message ? (
				<AccountManagementMessage tone={message.tone}>
					{message.text}
				</AccountManagementMessage>
			) : null}
			{data?.ok && data.people.length > 0 ? (
				<GiveAccessPicker orgSlug={data.org.slug} people={data.people} />
			) : null}
			{data?.ok ? <OrgGrantsPeopleTable data={data} /> : null}
			{data?.ok ? (
				<AccountManagementPanel
					title="Team and organization-wide grants"
					ariaLabel="Team and organization-wide grants"
				>
					{sharedGrants.length === 0 ? (
						<p css={mutedCopyCss} data-testid="org-grants-empty">
							No team or organization-wide grants. Outside collaborators appear
							on{' '}
							<SiteLink href={orgCollaboratorsPath(data.org.slug)}>
								Collaborators
							</SiteLink>
							{data.org.role === 'owner' ||
							data.org.role === 'admin' ||
							data.org.role === 'member' ? (
								<>
									; team subjects are managed under{' '}
									<SiteLink href={orgTeamsPath(data.org.slug)}>Teams</SiteLink>
								</>
							) : null}
							.
						</p>
					) : (
						<ul css={listCss} data-testid="org-grants">
							{sharedGrants.map((grant) => {
								const confirmed = armed === grant.id
								return (
									<li
										key={grant.id}
										data-testid="org-grant"
										data-grant-id={grant.id}
										css={rowItemCss}
									>
										<div css={rowCss}>
											<span aria-hidden="true" css={iconCss}>
												{renderIcon(
													grant.subjectType === 'org'
														? 'globe'
														: grant.subjectType === 'team'
															? 'users'
															: 'user',
													{ size: '1.25rem' },
												)}
											</span>
											<span css={rowTextCss}>
												<span css={rowNameCss}>{grantSummary(grant)}</span>
												<span css={rowDetailCss}>{grantDetail(grant)}</span>
											</span>
											{data.canManage && grant.canRevoke ? (
												<button
													type="button"
													data-testid="org-grant-revoke"
													css={getDangerPillCss({ size: 'sm' })}
													disabled={mutation.isPending}
													onBlur={() => setArmed(null)}
													onKeyDown={(event) => {
														if (event.key === 'Escape') setArmed(null)
													}}
													onClick={() => {
														if (!confirmed) {
															setArmed(grant.id)
															return
														}
														const isCurrent = capture()
														setMessage(null)
														mutation.mutate(
															{
																orgSlug: data.org.slug,
																grantId: grant.id,
															},
															{
																onSuccess: () => {
																	if (isCurrent()) {
																		setArmed(null)
																		setMessage({
																			tone: 'info',
																			text: 'Grant revoked.',
																		})
																	}
																},
																onError: (error) => {
																	if (isCurrent())
																		setMessage({
																			tone: 'error',
																			text: error.message,
																		})
																},
															},
														)
													}}
												>
													{renderIcon('close', { size: '1.05rem' })}
													{confirmed ? 'Confirm revoke' : 'Revoke'}
												</button>
											) : null}
										</div>
									</li>
								)
							})}
						</ul>
					)}
				</AccountManagementPanel>
			) : null}
			{data?.ok && data.orgWideRead ? (
				<>
					<OrgWideAccessForm
						kind="manage"
						orgSlug={data.org.slug}
						subjects={data.orgWideRead.subjects}
						queryKey={queryKey}
						canEdit={data.org.role === 'owner' || data.org.role === 'admin'}
					/>
					<OrgWideAccessForm
						kind="create"
						orgSlug={data.org.slug}
						subjects={data.orgWideRead.subjects}
						queryKey={queryKey}
					/>
					<OrgWideAccessForm
						kind="read"
						orgSlug={data.org.slug}
						subjects={data.orgWideRead.subjects}
						queryKey={queryKey}
					/>
				</>
			) : null}
		</AccountManagementShell>
	)
}

function GiveAccessPicker({
	orgSlug,
	people,
}: {
	orgSlug: string
	people: OrgGrantsLoaderData['people']
}) {
	const [userId, setUserId] = useState('')
	const members = people.filter((person) => person.kind === 'member')
	const outside = people.filter((person) => person.kind === 'collaborator')
	return (
		<AccountManagementPanel
			title="Give someone access"
			description="Open one person's access page to see everything they can use here, add packages and credentials in one go, or trim what they have."
		>
			<div css={formCss} data-testid="org-give-access">
				<label css={accountFieldCss}>
					<span css={accountFieldLabelCss}>Person</span>
					<select
						value={userId}
						data-field-ring
						data-testid="org-give-access-person"
						css={selectCss}
						onChange={(event) => setUserId(event.currentTarget.value)}
					>
						<option value="">Choose a member or collaborator…</option>
						{members.length > 0 ? (
							<optgroup label="Members">
								{members.map((person) => (
									<option key={person.userId} value={person.userId}>
										{person.label}
									</option>
								))}
							</optgroup>
						) : null}
						{outside.length > 0 ? (
							<optgroup label="Outside collaborators">
								{outside.map((person) => (
									<option key={person.userId} value={person.userId}>
										{person.label}
									</option>
								))}
							</optgroup>
						) : null}
					</select>
					<span css={accountFieldNoteCss}>
						Someone new? Invite them on Members first. Owners already have full
						access.
					</span>
				</label>
				<div css={accountActionsCss}>
					{userId ? (
						<SiteLink
							href={orgGrantAccessPath(orgSlug, userId)}
							data-testid="org-give-access-open"
							css={getPillButtonCss({ size: 'sm' })}
						>
							{renderIcon('key', { size: '1.05rem' })}
							Open access page
						</SiteLink>
					) : (
						<button
							type="button"
							disabled
							css={getPillButtonCss({ size: 'sm' })}
						>
							{renderIcon('key', { size: '1.05rem' })}
							Open access page
						</button>
					)}
				</div>
			</div>
		</AccountManagementPanel>
	)
}

type OrgWideAccessSubject = NonNullable<
	OrgGrantsLoaderData['orgWideRead']
>['subjects'][number]

const orgWideAccessForms = {
	read: {
		title: 'Organization-wide read access',
		description:
			'Let a member or team read every resource of a kind in this organization without making them an Owner. This is read only: it never lets them run, change, delete, or share anything.',
		legend: 'Can read',
		options: orgWideReadAccessOptions,
		held: (subject: OrgWideAccessSubject) => subject.reads,
		toPermissions: (
			selected: ReadonlyArray<string>,
			_subject: OrgWideAccessSubject,
		) => [...selected],
		ownerOnlyNote: null,
		testId: 'org-wide-read',
		save: 'Save read access',
		saved: (label: string) => `Read access saved for ${label}.`,
		send: grantOrganizationReadAccess,
	},
	create: {
		title: 'Create access',
		description:
			'Let a member or team create new packages, secrets, or connections in this organization. They get full access to what they create. Organization settings decide what every member can create.',
		legend: 'Can create',
		options: orgCreateAccessOptions,
		held: (subject: OrgWideAccessSubject) => subject.creates,
		toPermissions: (
			selected: ReadonlyArray<string>,
			_subject: OrgWideAccessSubject,
		) => [...selected],
		ownerOnlyNote: null,
		testId: 'org-create-access',
		save: 'Save create access',
		saved: (label: string) => `Create access saved for ${label}.`,
		send: grantOrganizationCreateAccess,
	},
	manage: {
		title: 'Manage every package and app',
		description:
			'Let a member or team run, change, publish, delete, and share every package and app in this organization, including ones created later, without granting each one. Changes to a package with unmappable credentials stay owner-only unless an Owner allows them on that package.',
		legend: 'Can manage',
		options: orgWideManageAccessOptions,
		held: (subject: OrgWideAccessSubject) =>
			heldOrgWideManageOptions(subject.manages),
		toPermissions: (
			selected: ReadonlyArray<string>,
			subject: OrgWideAccessSubject,
		) => orgWideManagePermissionsFor(selected, subject.manages),
		ownerOnlyNote:
			'Only an Owner can change manage access for the whole organization.',
		testId: 'org-wide-manage',
		save: 'Save manage access',
		saved: (label: string) => `Manage access saved for ${label}.`,
		send: grantOrganizationManageAccess,
	},
} as const

function OrgWideAccessForm({
	kind,
	orgSlug,
	subjects,
	queryKey,
	canEdit = true,
}: {
	kind: keyof typeof orgWideAccessForms
	orgSlug: string
	subjects: ReadonlyArray<OrgWideAccessSubject>
	queryKey: QueryKey
	canEdit?: boolean
}) {
	const form = orgWideAccessForms[kind]
	const capture = useSubmitterScope()
	const mutation = useOrgPeopleMutation(queryKey, form.send)
	const [subjectKey, setSubjectKey] = useState('')
	const [selected, setSelected] = useState<Array<string>>([])
	const [message, setMessage] = useState<{
		tone: 'info' | 'error'
		text: string
	} | null>(null)
	const subject = subjects.find((entry) => entry.key === subjectKey) ?? null
	const people = subjects.filter((entry) => entry.kind === 'user')
	const teams = subjects.filter((entry) => entry.kind === 'team')
	const unchanged =
		subject !== null &&
		selected.length === form.held(subject).length &&
		selected.every((permission) => form.held(subject).includes(permission))
	return (
		<AccountManagementPanel title={form.title} description={form.description}>
			{subjects.length === 0 ? (
				<p css={mutedCopyCss} data-testid={`${form.testId}-empty`}>
					Add members or teams to this organization first. Owners already have
					full access.
				</p>
			) : (
				<form
					data-testid={`${form.testId}-form`}
					css={formCss}
					onSubmit={(event) => {
						event.preventDefault()
						if (!subject) return
						const isCurrent = capture()
						setMessage(null)
						mutation.mutate(
							{
								orgSlug,
								subject: subject.key,
								permissions: form.toPermissions(selected, subject),
							},
							{
								onSuccess: () => {
									if (!isCurrent()) return
									setMessage({
										tone: 'info',
										text: form.saved(subject.label),
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
					<label css={accountFieldCss}>
						<span css={accountFieldLabelCss}>Member or team</span>
						<select
							name="subject"
							value={subjectKey}
							data-field-ring
							css={selectCss}
							onChange={(event) => {
								const next = event.currentTarget.value
								setSubjectKey(next)
								setSelected(
									(() => {
										const match = subjects.find((entry) => entry.key === next)
										return match ? [...form.held(match)] : []
									})(),
								)
								setMessage(null)
							}}
						>
							<option value="">Choose a member or team…</option>
							{people.length > 0 ? (
								<optgroup label="Members">
									{people.map((entry) => (
										<option key={entry.key} value={entry.key}>
											{entry.label}
										</option>
									))}
								</optgroup>
							) : null}
							{teams.length > 0 ? (
								<optgroup label="Teams">
									{teams.map((entry) => (
										<option key={entry.key} value={entry.key}>
											{entry.label}
										</option>
									))}
								</optgroup>
							) : null}
						</select>
						<p css={accountFieldNoteCss}>
							Edits this member or team's own organization grant. Access a
							member gets through a team is set on that team.
						</p>
					</label>
					<fieldset
						css={fieldsetCss}
						disabled={!canEdit || !subject || mutation.isPending}
					>
						<legend css={accountFieldLabelCss}>{form.legend}</legend>
						{form.options.map((option) => {
							const checked = selected.includes(option.permission)
							return (
								<label
									key={option.permission}
									css={checkRowCss}
									data-testid={`${form.testId}-option`}
									data-permission={option.permission}
								>
									<input
										type="checkbox"
										name="permissions"
										value={option.permission}
										checked={checked}
										css={checkboxCss}
										onChange={() =>
											setSelected((current) =>
												checked
													? current.filter(
															(permission) => permission !== option.permission,
														)
													: [...current, option.permission],
											)
										}
									/>
									<span css={checkTextCss}>
										<span css={checkLabelCss}>{option.label}</span>
										<span css={accountFieldNoteCss}>{option.description}</span>
									</span>
								</label>
							)
						})}
					</fieldset>
					{!canEdit && form.ownerOnlyNote ? (
						<p
							css={accountFieldNoteCss}
							data-testid={`${form.testId}-owner-only`}
						>
							{form.ownerOnlyNote}
						</p>
					) : null}
					{message ? (
						<AccountManagementMessage tone={message.tone}>
							{message.text}
						</AccountManagementMessage>
					) : null}
					<div css={accountActionsCss}>
						<button
							type="submit"
							data-testid={`${form.testId}-save`}
							disabled={!canEdit || !subject || unchanged || mutation.isPending}
							css={getPillButtonCss({ size: 'sm' })}
						>
							{renderIcon('check', { size: '1.05rem' })}
							{mutation.isPending ? 'Saving…' : form.save}
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
	flex: '1 1 auto',
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
