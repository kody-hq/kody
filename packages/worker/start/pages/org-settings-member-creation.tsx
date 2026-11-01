/** @jsxImportSource @emotion/react */
import { updateOrganizationMemberCreation } from '#start/server/org-settings-mutations'
import {
	useMutation,
	useQueryClient,
	type QueryKey,
} from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { useState } from 'react'
import { type OrgSettingsLoaderData } from '#universal/loader-data.ts'
import { orgGrantsPath } from '#universal/org-pages.ts'
import {
	getPillButtonCss,
	primaryLinkCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { SiteLink } from '../components/site-link.tsx'
import { renderIcon } from '../components/icon.tsx'
import { orgSettingsMutationOptions } from '../org-settings-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import {
	rebaseMemberCreationDraft,
	sameMemberCreation,
	type MemberCreation,
} from './org-settings-member-creation-draft.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	accountActionsCss,
	accountFieldNoteCss,
} from './account-management-components.tsx'

const memberCreationOptions: ReadonlyArray<{
	key: keyof MemberCreation
	label: string
	description: string
}> = [
	{
		key: 'packages',
		label: 'Members can create packages and apps',
		description:
			'Save new packages and repositories, including their apps, and publish them for the first time.',
	},
	{
		key: 'credentials',
		label: 'Members can create credentials',
		description:
			'Add new secrets, connect OAuth accounts, and add MCP servers for this organization.',
	},
]

export function OrgSettingsMemberCreation({
	data,
	queryKey,
}: {
	data: OrgSettingsLoaderData
	queryKey: QueryKey
}) {
	const saved = data.memberCreation
	const client = useQueryClient()
	const { actorKey } = useRouteContext({ from: '__root__' })
	const capture = useSubmitterScope()
	const [draft, setDraft] = useState<MemberCreation | null>(saved)
	const [draftBase, setDraftBase] = useState<MemberCreation | null>(saved)
	if (!sameMemberCreation(draftBase, saved)) {
		setDraftBase(saved)
		setDraft((current) => rebaseMemberCreationDraft(current, draftBase, saved))
	}
	const [message, setMessage] = useState<{
		text: string
		tone: 'info' | 'error'
	} | null>(null)
	const mutation = useMutation(
		orgSettingsMutationOptions(
			client,
			queryKey,
			actorKey,
			updateOrganizationMemberCreation,
		),
	)
	if (!saved || !draft) return null
	const unchanged =
		draft.packages === saved.packages && draft.credentials === saved.credentials
	return (
		<AccountManagementPanel
			title="Member permissions"
			description="Choose what every member can create without a grant. Owners can always create, and whoever creates something gets full access to it."
		>
			{data.canManage ? (
				<form
					css={formCss}
					data-testid="org-settings-member-creation"
					onSubmit={(event) => {
						event.preventDefault()
						if (mutation.isPending || unchanged) return
						const isCurrent = capture()
						setMessage(null)
						const changes: Partial<MemberCreation> = {}
						for (const option of memberCreationOptions) {
							if (draft[option.key] !== saved[option.key])
								changes[option.key] = draft[option.key]
						}
						mutation.mutate(
							{ orgSlug: data.org.slug, ...changes },
							{
								onSuccess: () => {
									if (isCurrent())
										setMessage({
											tone: 'info',
											text: 'Member permissions saved.',
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
					<fieldset css={fieldsetCss} disabled={mutation.isPending}>
						<legend css={visuallyHiddenCss}>Member permissions</legend>
						{memberCreationOptions.map((option) => (
							<label
								key={option.key}
								css={checkRowCss}
								data-testid="org-settings-member-creation-option"
								data-setting={option.key}
							>
								<input
									type="checkbox"
									name={option.key}
									checked={draft[option.key]}
									css={checkboxCss}
									onChange={(event) => {
										const checked = event.currentTarget.checked
										setMessage(null)
										setDraft((current) =>
											current ? { ...current, [option.key]: checked } : current,
										)
									}}
								/>
								<span css={checkTextCss}>
									<span css={checkLabelCss}>{option.label}</span>
									<span css={accountFieldNoteCss}>{option.description}</span>
								</span>
							</label>
						))}
					</fieldset>
					<p css={accountFieldNoteCss}>
						To let only some people or teams create, leave a setting off and add
						create access on{' '}
						<SiteLink css={primaryLinkCss} href={orgGrantsPath(data.org.slug)}>
							Grants
						</SiteLink>
						.
					</p>
					{message ? (
						<AccountManagementMessage tone={message.tone}>
							{message.text}
						</AccountManagementMessage>
					) : null}
					<div css={accountActionsCss}>
						<button
							type="submit"
							data-testid="org-settings-member-creation-save"
							disabled={unchanged || mutation.isPending}
							css={getPillButtonCss({ size: 'sm' })}
						>
							{renderIcon('check', { size: '1.05rem' })}
							{mutation.isPending ? 'Saving…' : 'Save member permissions'}
						</button>
					</div>
				</form>
			) : (
				<ul
					css={summaryListCss}
					data-testid="org-settings-member-creation-value"
				>
					{memberCreationOptions.map((option) => (
						<li key={option.key} css={mutedCopyCss}>
							{option.label}: {saved[option.key] ? 'On' : 'Off'}
						</li>
					))}
					<li css={mutedCopyCss}>Only an owner can change these.</li>
				</ul>
			)}
		</AccountManagementPanel>
	)
}

export const formCss = {
	display: 'grid',
	gap: spacing.lg,
}

export const fieldsetCss = {
	border: 0,
	margin: 0,
	padding: 0,
	minWidth: 0,
	display: 'grid',
	gap: spacing.sm,
	'&:disabled': { opacity: 0.6 },
}

export const checkRowCss = {
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

export const checkboxCss = {
	marginTop: '0.2rem',
	accentColor: colors.primary,
	flexShrink: 0,
}

export const checkTextCss = {
	display: 'grid',
	gap: '0.15rem',
	minWidth: 0,
}

export const checkLabelCss = {
	fontWeight: 600,
}

const summaryListCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.xs,
}

export const mutedCopyCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}
