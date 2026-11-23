/** @jsxImportSource @emotion/react */
import { Field } from '../components/field.tsx'
import {
	fieldCss,
	fieldLabelCss,
	fieldDescriptionCss,
} from '#universal/styles/style-primitives.ts'
import { Button } from '../components/button.tsx'
import type { CSSObject } from '@emotion/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { useId, useState } from 'react'
import { createRepository } from '#start/server/repositories'
import { routes } from '#universal/routes.ts'
import {
	repositoryNameError,
	repositoryNameHint,
	type RepositoryCreated,
	type RepositoryCreateOptions,
	type RepositoryOwnerOption,
} from '#universal/repository-create.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { CopyTextButton } from '../components/copy-text-button.tsx'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	accountActionsCss,
} from './account-management-components.tsx'
import { Input, InputAddon, InputGroup, Select } from '../components/input.tsx'

type Props = {
	payload: RepositoryCreateOptions
	orgSlug: string
	currentHref: string
}

export function RepositoryCreatePage(props: Props) {
	const [created, setCreated] = useState<RepositoryCreated | null>(null)
	const repositoriesHref = routes.orgRepositories.href({
		orgSlug: props.orgSlug,
	})
	return (
		<AccountManagementShell
			layout="form"
			currentHref={props.currentHref}
			maxWidth="44rem"
		>
			<AccountPageHeader
				title={created ? 'Repository created' : 'New repository'}
				description={
					created
						? 'Paste the prompt below into your agent to start building.'
						: 'A private git repository on Kody. Clone it, push to it, and turn it into a package whenever you are ready.'
				}
				currentHref={props.currentHref}
			/>
			{created ? (
				<RepositoryCreatedView
					created={created}
					repositoriesHref={repositoriesHref}
					onCreateAnother={() => setCreated(null)}
				/>
			) : (
				<RepositoryCreateForm
					owners={props.payload.owners}
					repositoriesHref={repositoriesHref}
					onCreated={setCreated}
				/>
			)}
		</AccountManagementShell>
	)
}

function ownerLabel(owner: RepositoryOwnerOption) {
	if (owner.personal) return `@${owner.slug} (personal)`
	return owner.displayName
		? `${owner.displayName} (@${owner.slug})`
		: `@${owner.slug}`
}

function RepositoryCreateForm(props: {
	owners: Array<RepositoryOwnerOption>
	repositoriesHref: string
	onCreated: (created: RepositoryCreated) => void
}) {
	const client = useQueryClient()
	const { actorKey } = useRouteContext({ from: '__root__' })
	const capture = useSubmitterScope()
	const ids = useId()
	const nameNoteId = `${ids}-name-note`
	const nameErrorId = `${ids}-name-error`
	const [owner, setOwner] = useState(
		() =>
			props.owners.find((option) => option.personal)?.slug ??
			props.owners[0]?.slug ??
			'',
	)
	const [name, setName] = useState('')
	const [showNameError, setShowNameError] = useState(false)
	const [serverError, setServerError] = useState<{
		message: string
		field: 'name' | 'owner' | null
	} | null>(null)
	const mutation = useMutation({
		mutationFn: (data: { ownerSlug: string; name: string }) =>
			createRepository({ data }),
		onSuccess: async (result) => {
			if (!result.ok) return
			await client.invalidateQueries({
				queryKey: ['page', actorKey, 'loadOrgRepositories'],
			})
		},
	})
	const liveError = repositoryNameError(name)
	const nameError =
		(showNameError ? liveError : null) ??
		(serverError?.field === 'name' ? serverError.message : null)
	const formError =
		serverError && serverError.field !== 'name'
			? serverError.message
			: (mutation.error?.message ?? null)

	if (props.owners.length === 0) {
		return (
			<AccountManagementMessage tone="error">
				You don&apos;t have permission to create repositories in any account.
			</AccountManagementMessage>
		)
	}

	return (
		<AccountManagementPanel title="Details">
			<form
				data-testid="repository-create-form"
				noValidate
				css={formCss}
				onSubmit={(event) => {
					event.preventDefault()
					if (mutation.isPending) return
					setShowNameError(true)
					if (liveError) return
					setServerError(null)
					const isCurrent = capture()
					mutation.mutate(
						{ ownerSlug: owner, name: name.trim() },
						{
							onSuccess: (result) => {
								if (!isCurrent()) return
								if (!result.ok) {
									setServerError({ message: result.error, field: result.field })
									return
								}
								props.onCreated(result)
							},
						},
					)
				}}
			>
				{formError ? (
					<AccountManagementMessage tone="error">
						{formError}
					</AccountManagementMessage>
				) : null}
				<Field label="Owner">
					<Select
						name="owner"
						value={owner}
						disabled={mutation.isPending}
						aria-invalid={serverError?.field === 'owner' || undefined}
						onChange={(event) => {
							setOwner(event.currentTarget.value)
							setServerError(null)
						}}
					>
						{props.owners.map((option) => (
							<option key={option.slug} value={option.slug}>
								{ownerLabel(option)}
							</option>
						))}
					</Select>
				</Field>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Repository name</span>
					<InputGroup>
						<InputAddon css={namePrefixCss} aria-hidden="true">
							@{owner}/
						</InputAddon>
						<Input
							name="name"
							value={name}
							required
							autoComplete="off"
							autoCapitalize="none"
							autoCorrect="off"
							spellCheck={false}
							placeholder="my-project"
							disabled={mutation.isPending}
							aria-invalid={nameError ? true : undefined}
							aria-describedby={
								nameError ? `${nameErrorId} ${nameNoteId}` : nameNoteId
							}
							onChange={(event) => {
								const next = event.currentTarget.value
								setName(next)
								setShowNameError(next.trim().length > 0)
								if (serverError?.field === 'name') setServerError(null)
							}}
							onBlur={() => setShowNameError(name.length > 0)}
						/>
					</InputGroup>
					{nameError ? (
						<span
							id={nameErrorId}
							css={nameErrorCss}
							data-testid="repository-name-error"
						>
							{nameError}
						</span>
					) : null}
					<span id={nameNoteId} css={fieldDescriptionCss}>
						{repositoryNameHint} New repositories are private.
					</span>
				</label>
				<div css={accountActionsCss}>
					<Button type="submit" disabled={mutation.isPending} variant="primary">
						{mutation.isPending ? 'Creating…' : 'Create repository'}
					</Button>
					<Button href={props.repositoriesHref} variant="secondary">
						Cancel
					</Button>
				</div>
			</form>
		</AccountManagementPanel>
	)
}

function RepositoryCreatedView(props: {
	created: RepositoryCreated
	repositoriesHref: string
	onCreateAnother: () => void
}) {
	const { created } = props
	return (
		<>
			<AccountManagementMessage>
				Created @{created.owner}/{created.name}. It is private and empty.
			</AccountManagementMessage>
			<AccountManagementPanel
				title="Start building with your agent"
				description="Copy this prompt into your coding agent. It explains how to clone the repository and work with it through the Kody CLI or the Kody MCP server. It contains no credentials; your agent signs in on its own."
			>
				<pre css={promptCss} data-testid="repository-start-prompt">
					<code>{created.prompt}</code>
				</pre>
				<div css={accountActionsCss}>
					<CopyTextButton
						value={created.prompt}
						variant="pill"
						size="sm"
						idleLabel="Copy prompt"
						copiedLabel="Copied"
						ariaLabel="Copy prompt"
					/>
					<Button href={created.repositoryHref} variant="secondary">
						Open repository
					</Button>
					<Button
						type="button"
						variant="secondary"
						onClick={props.onCreateAnother}
					>
						Create another
					</Button>
				</div>
			</AccountManagementPanel>
		</>
	)
}

const formCss: CSSObject = {
	display: 'grid',
	gap: spacing.lg,
}

const namePrefixCss: CSSObject = {
	maxWidth: '50%',
}

const nameErrorCss: CSSObject = {
	color: colors.error,
	fontSize: typography.fontSize.sm,
}

const promptCss: CSSObject = {
	margin: 0,
	padding: spacing.md,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
	background: colors.surface,
	color: colors.text,
	fontFamily: typography.fontFamilyMono,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.5,
	whiteSpace: 'pre-wrap',
	overflowWrap: 'anywhere',
	maxHeight: '28rem',
	overflowY: 'auto',
}
