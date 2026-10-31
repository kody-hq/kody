/** @jsxImportSource @emotion/react */
import {
	type OrgGrantsLoaderData,
	type OrgGrantView,
} from '#universal/loader-data.ts'
import { orgCollaboratorsPath, orgTeamsPath } from '#universal/org-pages.ts'
import {
	orgWideReadAccessLabel,
	orgWideReadAccessOptions,
} from '#universal/org-wide-read-access.ts'
import {
	orgCreateAccessLabel,
	orgCreateAccessOptions,
} from '#universal/org-create-access.ts'
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
import { type QueryKey } from '@tanstack/react-query'
import { useState } from 'react'
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
	grantOrganizationReadAccess,
	revokeOrganizationGrant,
} from '#start/server/org-mutations'
import { useOrgPeopleMutation } from './org-people-mutation.ts'
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
	const other = grant.permissions.filter(
		(permission) =>
			!orgWideReadAccessLabel(permission) && !orgCreateAccessLabel(permission),
	)
	const parts = [
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
			{data?.ok ? (
				<AccountManagementPanel
					title="Access grants"
					ariaLabel="Organization grants"
				>
					{data.grants.length === 0 ? (
						<p css={mutedCopyCss} data-testid="org-grants-empty">
							No grants yet. Grant access with{' '}
							<code css={codeCss}>accessGrant</code> or invite someone to a
							package. Outside collaborators appear on{' '}
							<SiteLink href={orgCollaboratorsPath(data.org.slug)}>
								Collaborators
							</SiteLink>
							{data.org.role === 'owner' || data.org.role === 'member' ? (
								<>
									; team subjects are managed under{' '}
									<SiteLink href={orgTeamsPath(data.org.slug)}>Teams</SiteLink>
								</>
							) : null}
							.
						</p>
					) : (
						<ul css={listCss} data-testid="org-grants">
							{data.grants.map((grant) => {
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
		testId: 'org-create-access',
		save: 'Save create access',
		saved: (label: string) => `Create access saved for ${label}.`,
		send: grantOrganizationCreateAccess,
	},
} as const

function OrgWideAccessForm({
	kind,
	orgSlug,
	subjects,
	queryKey,
}: {
	kind: keyof typeof orgWideAccessForms
	orgSlug: string
	subjects: ReadonlyArray<OrgWideAccessSubject>
	queryKey: QueryKey
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
							{ orgSlug, subject: subject.key, permissions: selected },
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
					<fieldset css={fieldsetCss} disabled={!subject || mutation.isPending}>
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
					{message ? (
						<AccountManagementMessage tone={message.tone}>
							{message.text}
						</AccountManagementMessage>
					) : null}
					<div css={accountActionsCss}>
						<button
							type="submit"
							data-testid={`${form.testId}-save`}
							disabled={!subject || unchanged || mutation.isPending}
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

const codeCss = {
	fontSize: '0.9em',
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
