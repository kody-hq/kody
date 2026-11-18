/** @jsxImportSource @emotion/react */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { Button } from '../components/button.tsx'
import { LoadingIndicator } from '../components/loading-indicator.tsx'
import { createPageQuery } from '../page-query.ts'
import { secretsInput } from '../secrets-input.ts'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { loadSecretsPage } from '#start/server/account-collections'
import type { CredentialListItem } from '#universal/credential-contracts.ts'
import type {
	AccountSecretDetail,
	AccountSecretsLoaderData,
} from '#universal/loader-data.ts'
import { spacing } from '#universal/styles/tokens.ts'
import { AccountManagementMessage } from './account-management-components.tsx'
import { SecretEditor } from './account-secrets-editor.tsx'
import { createEditorStateFromSecret } from './account-secrets-shared.ts'
import {
	secretMutationResources,
	useSecretEditor,
} from './use-secret-editor.ts'

const secretsPageQuery = createPageQuery('loadSecretsPage', loadSecretsPage, {
	staleTime: 60_000,
})

const editResources = [
	...secretMutationResources,
	'loadCredentialsPage',
] as const

function editsInline(kind: CredentialListItem['kind']) {
	switch (kind) {
		case 'secret':
		case 'url':
		case 'login':
		case 'signing':
			return true
		case 'oauth':
		case 'mcp':
			return false
		default: {
			const exhaustive: never = kind
			return exhaustive
		}
	}
}

/**
 * Edit opens the secret's form in place: no navigation, so the page keeps
 * its scroll on open, save, and cancel. Connections still open their page.
 */
export function CredentialEditAction(props: {
	credential: CredentialListItem
	/** The org that owns the credential (a personal one edits in its owner's org). */
	editOrgSlug: string
	manageHref: string
	listHref: string
	label: string
}) {
	const [editing, setEditing] = useState(false)
	if (!editsInline(props.credential.kind)) {
		return (
			<div>
				<Button href={props.manageHref} variant="secondary">
					{props.label}
				</Button>
			</div>
		)
	}
	if (!editing) {
		return (
			<div>
				<Button
					type="button"
					variant="secondary"
					aria-expanded="false"
					data-testid="credential-edit"
					onClick={() => setEditing(true)}
				>
					{props.label}
				</Button>
			</div>
		)
	}
	return <CredentialSecretEditor {...props} onClose={() => setEditing(false)} />
}

function CredentialSecretEditor(props: {
	credential: CredentialListItem
	editOrgSlug: string
	manageHref: string
	listHref: string
	onClose: () => void
}) {
	const { actorKey } = useMatchedPageScope()
	const { credential } = props
	const query = useQuery(
		secretsPageQuery(
			actorKey,
			secretsInput(
				props.editOrgSlug,
				'',
				credential.packageId
					? {
							scope: 'package',
							packageId: credential.packageId,
							name: credential.name,
						}
					: { scope: 'user', name: credential.name },
			),
		),
	)
	if (query.isPending) return <LoadingIndicator label="Loading the editor…" />
	const payload = query.data?.payload ?? null
	const secret = payload?.selectedSecret ?? null
	if (!payload || !secret) {
		return (
			<div css={{ display: 'grid', gap: spacing.sm, justifyItems: 'start' }}>
				<AccountManagementMessage tone="error">
					Kody could not load this secret for editing.
				</AccountManagementMessage>
				<div css={{ display: 'flex', gap: spacing.sm, flexWrap: 'wrap' }}>
					<Button href={props.manageHref} variant="secondary">
						Open it on the Secrets page
					</Button>
					<Button type="button" variant="secondary" onClick={props.onClose}>
						Cancel
					</Button>
				</div>
			</div>
		)
	}
	return (
		<LoadedCredentialSecretEditor
			payload={payload}
			secret={secret}
			editOrgSlug={props.editOrgSlug}
			listHref={props.listHref}
			onClose={props.onClose}
		/>
	)
}

function LoadedCredentialSecretEditor(props: {
	payload: AccountSecretsLoaderData
	secret: AccountSecretDetail
	editOrgSlug: string
	listHref: string
	onClose: () => void
}) {
	const router = useRouter()
	const queryClient = useQueryClient()
	const { actorKey } = useMatchedPageScope()
	const { payload, secret } = props
	// A personal credential shown in a team org saves in its owner's org, so
	// refresh this page's list too.
	const refreshCredentials = () =>
		queryClient.invalidateQueries({
			queryKey: ['page', actorKey, 'loadCredentialsPage'],
		})
	const editor = useSecretEditor({
		actorKey,
		orgSlug: props.editOrgSlug,
		resources: editResources,
		initialEditorState: createEditorStateFromSecret(secret),
		getSearch: () => '',
		onSaved: (saved) => {
			void refreshCredentials()
			// A scope or package change saves a new credential and removes this one.
			if (
				saved &&
				(saved.scope !== secret.scope || saved.packageId !== secret.packageId)
			) {
				void router.navigate({ to: props.listHref, resetScroll: false })
				return
			}
			props.onClose()
		},
		onSaveRefused: () => {},
		onDeleted: () => {
			void refreshCredentials()
			void router.navigate({ to: props.listHref, resetScroll: false })
		},
	})
	const kodyIds = new Map(payload.packages.map((pkg) => [pkg.id, pkg.kodyId]))
	return (
		<div css={{ display: 'grid', gap: spacing.sm }}>
			{editor.message ? (
				<AccountManagementMessage tone="info">
					{editor.message}
				</AccountManagementMessage>
			) : null}
			<SecretEditor
				{...editor.editorProps}
				isCreating={false}
				selectedSecret={secret}
				packageOptions={payload.packageOptions}
				packageSelectOptions={payload.packageOptions.map((option) => ({
					id: option.id,
					label: kodyIds.get(option.id) ?? option.title,
					keywords: [option.id],
				}))}
				canCreatePackageSecrets={payload.packageOptions.length > 0}
				isMutating={editor.saveState !== 'idle'}
				secretValueAutofocusKey=""
				disconnected={secret.disconnected === true}
				onCancel={props.onClose}
			/>
		</div>
	)
}
