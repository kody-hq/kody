import { useActorRef } from '@xstate/react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'
import { submissionGateState } from '#client/routes/submission-gate-state.ts'
import { normalizeAllowedHosts } from '#client/routes/secret-normalization.ts'
import { toast } from '#client/toast.ts'
import {
	deleteSecret,
	disconnectSecret,
	saveSecret,
} from '#start/server/account-mutations'
import { fillPlacementViewFromDraft } from '#universal/credential-fill-placement.ts'
import type { AccountSecretDetail } from '#universal/loader-data.ts'
import type { PageMutationDependencies } from '../page-invalidation-cache.ts'
import { secretMutationOptions } from '../secret-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import {
	type EditorState,
	applyStuckRenameRecovery,
	collectRepeatedTextRows,
	createEditorStateFromSecret,
	readAccountSecretsSaveWarning,
} from './account-secrets-shared.ts'

/** Pages a secret write can change. */
export const secretMutationResources = [
	'loadSecretsPage',
	'loadOnboarding',
	'loadAccountPage',
	'loadUsagePage',
] as const

/**
 * Save, delete, and disconnect for one secret editor. The Secrets page and the
 * inline Edit on a credential's page share it; each says where to go next.
 */
export function useSecretEditor(input: {
	actorKey: string | null
	orgSlug: string | null
	resources: PageMutationDependencies
	initialEditorState: EditorState
	initialMessage?: string | null
	/** The current search, for rename recovery after a refused save. */
	getSearch: () => string
	onSaved: (secret: AccountSecretDetail | null, wasCreating: boolean) => void
	onSaveRefused: (href: string) => void
	onDeleted: () => void
}) {
	const [editorState, setEditorState] = useState(input.initialEditorState)
	const [savedEditorState, setSavedEditorState] = useState(editorState)
	const [message, setMessage] = useState<string | null>(
		input.initialMessage ?? null,
	)
	const [showSecretValue, setShowSecretValue] = useState(false)
	const [deleteArmed, setDeleteArmed] = useState(false)
	const [disconnectArmed, setDisconnectArmed] = useState(false)
	const runExclusiveActor = useActorRef(submissionGateState)
	const queryClient = useQueryClient()
	const capture = useSubmitterScope()
	const options = <TInput, TResult>(
		send: (request: { data: TInput }) => Promise<TResult>,
	) =>
		secretMutationOptions(
			queryClient,
			input.actorKey,
			input.orgSlug,
			input.resources,
			send,
		)
	const save = useMutation(options(saveSecret))
	const remove = useMutation(options(deleteSecret))
	const disconnect = useMutation(options(disconnectSecret))
	const saveState = save.isPending
		? ('saving' as const)
		: remove.isPending
			? ('deleting' as const)
			: disconnect.isPending
				? ('disconnecting' as const)
				: ('idle' as const)
	const orgSlug = input.orgSlug ?? undefined

	function resetMutations() {
		save.reset()
		remove.reset()
		disconnect.reset()
	}

	async function exclusive(fallback: string, run: () => Promise<void>) {
		if (!runExclusiveActor.getSnapshot().can({ type: 'SUBMIT' })) return
		runExclusiveActor.send({ type: 'SUBMIT' })
		try {
			if (saveState !== 'idle') return
			setMessage(null)
			const isCurrent = capture()
			try {
				await run()
			} catch (error) {
				if (!isCurrent()) return
				setMessage(error instanceof Error ? error.message : fallback)
			} finally {
				if (isCurrent()) resetMutations()
			}
		} finally {
			runExclusiveActor.send({ type: 'SETTLED' })
		}
	}

	function saveSecretChanges(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		const form = event.currentTarget as HTMLFormElement
		const submitted = editorState
		return exclusive('Unable to save secret.', async () => {
			const allowedHosts = normalizeAllowedHosts(
				collectRepeatedTextRows(form, 'allowed-hosts'),
			)
			const allowedPackages =
				submitted.scope === 'user'
					? [...submitted.allowedPackages].sort((left, right) =>
							left.localeCompare(right),
						)
					: []
			const placement = fillPlacementViewFromDraft(submitted.fillPlacement)
			if (
				placement === null &&
				!(
					submitted.fillPlacement.headers &&
					submitted.fillPlacement.query &&
					submitted.fillPlacement.path &&
					submitted.fillPlacement.body
				)
			) {
				throw new Error('Choose at least one fill-placement part.')
			}
			const payload = await save.mutateAsync({
				orgSlug,
				fields: {
					currentId: submitted.currentId,
					name: submitted.name,
					scope: submitted.scope,
					packageId: submitted.scope === 'package' ? submitted.packageId : null,
					description: submitted.description,
					expiresAt: submitted.expiresAt || null,
					value: submitted.value,
					allowedHosts,
					allowedPackages,
					placement,
				},
			})
			if (!payload.ok) {
				const recovered = applyStuckRenameRecovery({
					editor: submitted,
					stuck: payload.selectedSecret,
					search: input.getSearch(),
				})
				setEditorState(recovered.editor)
				setDisconnectArmed(false)
				toast.error(payload.error)
				input.onSaveRefused(recovered.href)
				return
			}
			const warning = readAccountSecretsSaveWarning(payload)
			if (warning) toast.error(warning)
			const wasCreating = !submitted.currentId
			const savedEditor = createEditorStateFromSecret(payload.selectedSecret)
			setEditorState(savedEditor)
			setSavedEditorState(savedEditor)
			setShowSecretValue(false)
			setDeleteArmed(false)
			setDisconnectArmed(false)
			setMessage(warning)
			if (!warning)
				toast.success(wasCreating ? 'Created secret.' : 'Saved secret.')
			input.onSaved(payload.selectedSecret, wasCreating)
		})
	}

	function deleteSelectedSecret() {
		const currentId = editorState.currentId
		if (!currentId) return
		void exclusive('Unable to delete secret.', async () => {
			await remove.mutateAsync({ orgSlug, fields: { currentId } })
			input.onDeleted()
		})
	}

	function disconnectSelectedSecret() {
		const currentId = editorState.currentId
		if (!currentId) return
		void exclusive('Unable to disconnect secret.', async () => {
			await disconnect.mutateAsync({ orgSlug, fields: { currentId } })
			setDisconnectArmed(false)
			setDeleteArmed(false)
			setMessage(
				'Disconnected. The credential record and placement remain. Save a value to reconnect.',
			)
			setEditorState({ ...editorState, value: '' })
			setShowSecretValue(false)
		})
	}

	return {
		editorState,
		setEditorState,
		savedEditorState,
		setSavedEditorState,
		message,
		setMessage,
		showSecretValue,
		setShowSecretValue,
		deleteArmed,
		setDeleteArmed,
		disconnectArmed,
		setDisconnectArmed,
		saveState,
		runExclusiveActor,
		capture,
		resetMutations,
		/** Everything `SecretEditor` takes that comes from this editor. */
		editorProps: {
			editorState,
			setEditorState,
			saveState,
			showSecretValue,
			onToggleShowSecretValue: () => setShowSecretValue(!showSecretValue),
			deleteArmed,
			onDeleteArm: () => {
				setDisconnectArmed(false)
				setDeleteArmed(true)
			},
			onDeleteReset: () => setDeleteArmed(false),
			disconnectArmed,
			onDisconnectArm: () => {
				setDeleteArmed(false)
				setDisconnectArmed(true)
			},
			onDisconnectReset: () => setDisconnectArmed(false),
			onSave: (event: FormEvent<HTMLFormElement>) =>
				void saveSecretChanges(event),
			onDelete: deleteSelectedSecret,
			onDisconnect: disconnectSelectedSecret,
			updateAllowedHost: (index: number, value: string) =>
				setEditorState({
					...editorState,
					allowedHosts: editorState.allowedHosts.map((host, hostIndex) =>
						hostIndex === index ? value : host,
					),
				}),
			addAllowedHost: () =>
				setEditorState({
					...editorState,
					allowedHosts: [...editorState.allowedHosts, ''],
				}),
			removeAllowedHost: (index: number) => {
				const nextHosts = editorState.allowedHosts.filter(
					(_host, hostIndex) => hostIndex !== index,
				)
				setEditorState({
					...editorState,
					allowedHosts: nextHosts.length > 0 ? nextHosts : [''],
				})
			},
			addAllowedPackage: (packageId: string) => {
				if (editorState.allowedPackages.includes(packageId)) return
				setEditorState({
					...editorState,
					allowedPackages: [...editorState.allowedPackages, packageId],
				})
			},
			removeAllowedPackage: (packageId: string) =>
				setEditorState({
					...editorState,
					allowedPackages: editorState.allowedPackages.filter(
						(candidate) => candidate !== packageId,
					),
				}),
		},
	}
}
