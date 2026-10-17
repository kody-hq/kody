/** @jsxImportSource @emotion/react */
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { toast } from '#client/toast.ts'
import {
	resumeOutboundEmailDelivery,
	classifyEmailMessage,
	deleteEmailMessage,
} from '#start/server/account-mutations'
import { acceptedEmailVerificationDelivery } from '#universal/email-verification-delivery.ts'
import {
	type AccountEmailDestinationsLoaderData,
	type AccountEmailLoaderData,
	type AccountEmailMessageDetail,
} from '#universal/loader-data.ts'
import { relocateAccountHref } from '#universal/org-pages.ts'
import { getGhostButtonCss } from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	useMutation,
	useMutationState,
	useQueryClient,
} from '@tanstack/react-query'
import { useRouteContext, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { formatNullableTimestamp } from '../components/local-timestamp.tsx'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { useShellData } from '../routes/__root.tsx'
import { invalidateShellQueries } from '../shell-query.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { useAccountEmailDestinations } from './account-email-destinations-client.ts'
import { renderAccountEmailDestinationsPanel } from './account-email-destinations-panel.tsx'
import { renderAccountEmailDetail } from './account-email-detail.tsx'
import {
	emailMutationOptions,
	optimisticEmail,
	type EmailAction,
} from './account-email-query.ts'
import {
	directionLabel,
	emailRoute,
	messageDate,
	quarantinedBadgeCss,
	senderBadgeCss,
	senderClassificationLabel,
	statusLabel,
	subjectCellCss,
	truncatedTextCss,
	type ClassificationFilter,
} from './account-email-shared.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AccountPageHeader,
} from './account-management-components.tsx'
import { emailResumeMutationOptions } from './email-resume-mutation.ts'
import { emailKeys } from './email-resources.ts'
import {
	renderEmailVerificationPrompt,
	requestResendVerification,
} from './email-verification-prompt.tsx'
import {
	RecordTable,
	RecordTableSearch,
	RecordTableSelect,
	recordStampCss,
} from './record-table.tsx'

export function AccountEmailPage({
	payload,
	destinations,
	currentHref,
	selectedId,
}: {
	payload: AccountEmailLoaderData
	destinations: AccountEmailDestinationsLoaderData
	currentHref: string
	selectedId: string | null
}) {
	const queryClient = useQueryClient()
	const { actorKey } = useRouteContext({ from: '__root__' })
	const { orgSlug: org, pageLocation } = useMatchedPageScope()
	const mutationKey = emailKeys.mutations(actorKey, org)
	const pendingActions = useMutationState({
		filters: {
			mutationKey: emailKeys.mutations(actorKey, org),
			status: 'pending',
		},
		select: (mutation) => mutation.state.variables as EmailAction,
	})
	// Overlay intent instead of replacing the shared server cache. Background
	// reads and another mutation's rollback cannot erase an in-flight edit.
	const data = pendingActions.reduce(optimisticEmail, payload)
	const [notice, setNotice] = useState<{ href: string; text: string } | null>(
		null,
	)
	const message = notice?.href === currentHref ? notice.text : null
	const setMessage = (text: string | null) =>
		setNotice(text ? { href: currentHref, text } : null)
	const [deleteArmedId, setDeleteArmedId] = useState<string | null>(null)
	const deleteArmed =
		deleteArmedId !== null && deleteArmedId === data.selectedMessage?.id
	const [resendStatus, setResendStatus] = useState<'idle' | 'sending'>('idle')
	const [resendMessage, setResendMessage] = useState<string | null>(null)
	const [resendTone, setResendTone] = useState<'error' | 'info'>('info')
	const [resendAccepted, setResendAccepted] = useState(false)
	const accountEmailDestinations = useAccountEmailDestinations(
		destinations,
		actorKey,
	)
	const { session } = useShellData()
	const invalidatePages = () =>
		Promise.all([
			queryClient.invalidateQueries({ queryKey: emailKeys.all(actorKey, org) }),
			queryClient.invalidateQueries({
				queryKey: emailKeys.destinations(actorKey),
			}),
			invalidateShellQueries(queryClient, actorKey),
		])
	const router = useRouter()
	const navigate = (href: string) =>
		void router.navigate({
			to: relocateAccountHref(href, currentHref),
			resetScroll: false,
		})

	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })

	function getCurrentHref() {
		return currentHref
	}

	function getCurrentSearch() {
		return new URL(getCurrentHref(), 'http://localhost').search
	}

	function updateFilters(next: {
		query?: string
		classification?: ClassificationFilter
		pageDelta?: number
	}) {
		const matchedUrl = new URL(currentHref, 'http://localhost')
		// Consecutive edits compose before the prior read settles, but a
		// retained inbox cannot borrow search from a different destination.
		const samePage = router.latestLocation.pathname === matchedUrl.pathname
		return router.navigate({
			to: matchedUrl.pathname,
			replace: true,
			resetScroll: false,
			search: (previous: Record<string, unknown>) => {
				const search: Record<string, unknown> = samePage
					? { ...previous }
					: { ...pageLocation.search }
				if (next.query !== undefined) {
					if (next.query) search.q = next.query
					else delete search.q
					delete search.page
				}
				if (next.classification !== undefined) {
					if (next.classification === 'all') delete search.classification
					else search.classification = next.classification
					delete search.page
				}
				if (next.pageDelta !== undefined) {
					const previousPage = Number.parseInt(String(search.page ?? 1), 10)
					const page = Math.max(
						1,
						(Number.isFinite(previousPage) ? previousPage : 1) + next.pageDelta,
					)
					if (page > 1) search.page = page
					else delete search.page
				}
				return search
			},
		})
	}

	const resendMutation = useMutation({
		mutationFn: requestResendVerification,
		onMutate: () => invalidatePages,
		onSettled: (_data, _error, _variables, reconcile) => reconcile?.(),
		gcTime: 0,
	})

	async function handleResendVerification() {
		const isCurrentSubmitter = captureSubmitter()
		setResendStatus('sending')
		setResendMessage(null)
		setResendTone('info')

		try {
			const result = await resendMutation.mutateAsync()
			if (!isCurrentSubmitter()) return
			setResendTone(result.ok ? 'info' : 'error')
			setResendMessage(result.message)
			if (result.ok) {
				setResendAccepted(true)
			}
		} catch {
			if (!isCurrentSubmitter()) return
			setResendTone('error')
			setResendMessage('Unable to send the verification email.')
		} finally {
			if (isCurrentSubmitter()) setResendStatus('idle')
		}
	}

	const captureSubmitter = useSubmitterScope()
	const resumeMutation = useMutation(
		emailResumeMutationOptions(queryClient, resumeOutboundEmailDelivery),
	)
	async function resumeOutbound() {
		if (resumeMutation.isPending || !data.outboundDeliveryPausedAt) return
		const isCurrent = captureSubmitter()
		setMessage(null)
		try {
			await resumeMutation.mutateAsync({ actorKey, orgSlug: org })
			if (isCurrent()) setMessage('Outbound email resumed.')
		} catch (error) {
			if (isCurrent()) toast.error(getErrorMessage(error))
		}
	}

	const classifyState = pendingActions.some(
		(action) =>
			action.action === 'classify' &&
			action.messageId === data.selectedMessage?.id,
	)
		? 'saving'
		: 'idle'
	const deleteState = pendingActions.some(
		(action) =>
			action.action === 'delete' &&
			action.messageId === data.selectedMessage?.id,
	)
		? 'deleting'
		: 'idle'

	const deleteMutation = useMutation(
		emailMutationOptions<Extract<EmailAction, { action: 'delete' }>>(
			queryClient,
			actorKey,
			(action) =>
				deleteEmailMessage({
					data: {
						orgSlug: action.orgSlug ?? undefined,
						messageId: action.messageId,
					},
				}),
			{ orgSlug: org },
		),
	)
	const classifyMutation = useMutation(
		emailMutationOptions<Extract<EmailAction, { action: 'classify' }>>(
			queryClient,
			actorKey,
			(action) =>
				classifyEmailMessage({
					data: {
						orgSlug: action.orgSlug ?? undefined,
						messageId: action.messageId,
						classification: action.classification,
					},
				}),
			{ orgSlug: org },
		),
	)

	function deleteSelectedMessage() {
		const selected = data.selectedMessage
		if (
			!selected ||
			queryClient.isMutating({
				mutationKey,
				predicate: (mutation) =>
					(mutation.state.variables as EmailAction | undefined)?.messageId ===
					selected?.id,
			})
		)
			return
		setMessage(null)
		const listHref = emailRoute.buildListHref(getCurrentSearch(), currentHref)
		const isCurrentSubmitter = captureSubmitter()
		deleteMutation.mutate(
			{
				action: 'delete',
				messageId: selected.id,
				orgSlug: org,
			},
			{
				onSuccess: () => {
					if (!isCurrentSubmitter()) return
					setDeleteArmedId(null)
					setMessage('Message deleted.')
					navigate(listHref)
				},
				onError: (error) => {
					if (isCurrentSubmitter()) {
						setDeleteArmedId(null)
						toast.error(getErrorMessage(error))
					}
				},
			},
		)
	}

	function classifySelectedMessage(classification: 'accepted' | 'quarantined') {
		const selected = data.selectedMessage
		if (
			!selected ||
			selected.direction !== 'inbound' ||
			queryClient.isMutating({
				mutationKey,
				predicate: (mutation) =>
					(mutation.state.variables as EmailAction | undefined)?.messageId ===
					selected?.id,
			})
		)
			return
		setMessage(null)
		const isCurrentSubmitter = captureSubmitter()
		classifyMutation.mutate(
			{
				action: 'classify',
				messageId: selected.id,
				classification,
				orgSlug: org,
			},
			{
				onSuccess: () => {
					if (!isCurrentSubmitter()) return
					setMessage(
						classification === 'quarantined'
							? 'Marked as spam.'
							: 'Marked as not spam.',
					)
				},
				onError: (error) => {
					if (isCurrentSubmitter()) toast.error(getErrorMessage(error))
				},
			},
		)
	}

	const selectedMessageId = selectedId
	const selectedMessage: AccountEmailMessageDetail | null = data.selectedMessage
	const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize))
	const currentPage = data.page
	const searchQuery = data.query
	const classificationFilter =
		data.classification === 'quarantined' ? 'quarantined' : 'all'
	const showUnverified = !data.emailVerified

	return (
		<AccountManagementShell
			currentHref={currentHref}
			maxWidth="min(100%, 92rem)"
			busy={false}
		>
			<AccountPageHeader
				entity="email"
				title="Email inbox"
				description="Browse inbound and outbound messages for your platform email address. Compose and reply through Kody agents. Manage the addresses emailSend may use here."
				currentHref={currentHref}
			/>

			{message ||
			(data.emailVerified && selectedMessageId && !selectedMessage) ? (
				<AccountManagementMessage tone={message ? 'info' : 'error'}>
					{message ?? 'Message not found.'}
				</AccountManagementMessage>
			) : null}
			{!showUnverified ? (
				<>
					{data.outboundDeliveryPausedAt ? (
						<div
							css={{
								display: 'grid',
								gap: spacing.sm,
								marginBottom: spacing.md,
								padding: spacing.md,
								border: `1px solid ${colors.border}`,
								borderRadius: '8px',
								background: colors.primarySoftest,
							}}
							data-testid="outbound-email-paused"
						>
							<p css={{ margin: 0 }}>
								Outbound email is paused after repeated delivery failures.
								Resume once the destination can receive mail from kody.codes
								again.
							</p>
							<button
								type="button"
								css={secondaryButtonCss}
								disabled={resumeMutation.isPending}
								data-testid="resume-outbound-email"
								onClick={() => void resumeOutbound()}
							>
								{resumeMutation.isPending
									? 'Resuming…'
									: 'Resume outbound email'}
							</button>
						</div>
					) : null}
					{data.usage || data.inboxAddress ? (
						<div
							css={{
								display: 'grid',
								gap: spacing.sm,
								marginBottom: spacing.md,
							}}
						>
							{data.inboxAddress ? (
								<p css={{ margin: 0, color: colors.text }}>
									Inbox address:{' '}
									<code css={{ overflowWrap: 'anywhere' }}>
										{data.inboxAddress}
									</code>
								</p>
							) : null}
							{data.usage ? (
								<p
									css={{
										margin: 0,
										color: colors.textMuted,
										fontSize: typography.fontSize.sm,
									}}
								>
									Plan {data.usage.plan}: {data.usage.stored_messages.count}/
									{data.usage.stored_messages.limit} stored ·{' '}
									{data.usage.receives_today.count}/
									{data.usage.receives_today.limit} received today ·{' '}
									{data.usage.sends_today.count}/{data.usage.sends_today.limit}{' '}
									sent today
								</p>
							) : null}
						</div>
					) : null}
					{destinations
						? renderAccountEmailDestinationsPanel({
								destinations: accountEmailDestinations.destinations,
								additionalRemaining:
									accountEmailDestinations.additionalRemaining,
								additionalLimit: accountEmailDestinations.additionalLimit,
								draftEmail: accountEmailDestinations.draftEmail,
								status: accountEmailDestinations.status,
								message: accountEmailDestinations.message,
								tone: accountEmailDestinations.tone,
								pendingId: accountEmailDestinations.pendingId,
								onDraftEmailInput: accountEmailDestinations.updateDraftEmail,
								onAddSubmit: (event) => {
									void accountEmailDestinations.handleAddSubmit(event)
								},
								onResend: (id) => {
									void accountEmailDestinations.resend(id)
								},
								onSetDefault: (id) => {
									void accountEmailDestinations.setDefault(id)
								},
								onRemove: (id) => {
									void accountEmailDestinations.remove(id)
								},
							})
						: null}
					<RecordTable
						mode="expand"
						busy={false}
						ariaLabel="Inbox messages"
						selectedId={selectedMessageId}
						countLabel={`${data.total} ${data.total === 1 ? 'message' : 'messages'}`}
						emptyLabel={
							searchQuery || classificationFilter !== 'all'
								? 'No messages match the current filters.'
								: 'No messages in your inbox yet.'
						}
						toolbar={
							<>
								<RecordTableSearch
									label="Search messages"
									placeholder="Search subject or from"
									value={
										new URL(currentHref, 'http://localhost').searchParams.get(
											'q',
										) ?? ''
									}
									onInput={(value) => {
										return updateFilters({ query: value })
									}}
								/>
								<RecordTableSelect
									label="Filter messages by classification"
									value={classificationFilter}
									onChange={(value) => {
										updateFilters({
											classification:
												value === 'quarantined' ? 'quarantined' : 'all',
										})
									}}
								>
									<option value="all">All messages</option>
									<option value="quarantined">Quarantined</option>
								</RecordTableSelect>
							</>
						}
						columns={[
							{ key: 'subject', label: 'Subject', primary: true },
							{ key: 'from', label: 'From', drop: 1 },
							{ key: 'direction', label: 'Direction', drop: 3 },
							{ key: 'status', label: 'Status', drop: 2 },
							{ key: 'date', label: 'Date' },
						]}
						rows={data.messages.map((emailMessage) => ({
							id: emailMessage.id,
							href: emailRoute.buildDetailHref(
								emailMessage.id,
								getCurrentSearch(),
								currentHref,
							),
							cells: {
								subject: (
									<span css={subjectCellCss}>
										<span css={truncatedTextCss}>
											{emailMessage.subject || '(no subject)'}
										</span>
										{emailMessage.classification === 'quarantined' ? (
											<span
												title={
													emailMessage.classification_reason ?? 'Quarantined'
												}
												css={quarantinedBadgeCss}
											>
												Quarantined
											</span>
										) : null}
									</span>
								),
								from: (
									<span css={subjectCellCss}>
										<span css={truncatedTextCss}>
											{emailMessage.from_address ??
												emailMessage.envelope_from ??
												'Unknown sender'}
										</span>
										{senderClassificationLabel(
											emailMessage.sender_classification,
										) ? (
											<span
												title={
													emailMessage.sender_classification_reason ?? undefined
												}
												css={senderBadgeCss}
											>
												{senderClassificationLabel(
													emailMessage.sender_classification,
												)}
											</span>
										) : null}
									</span>
								),
								direction: directionLabel(emailMessage.direction),
								status: statusLabel(emailMessage),
								date: (
									<span css={recordStampCss}>
										{formatNullableTimestamp(
											messageDate(emailMessage),
											'Unknown',
										)}
									</span>
								),
							},
						}))}
						footer={
							totalPages > 1 ? (
								<div
									css={{
										display: 'flex',
										gap: spacing.sm,
										alignItems: 'center',
										justifyContent: 'center',
									}}
								>
									<button
										type="button"
										disabled={currentPage <= 1}
										onClick={() => {
											updateFilters({ pageDelta: -1 })
										}}
										css={secondaryButtonCss}
									>
										Previous
									</button>
									<p
										css={{
											margin: 0,
											color: colors.textMuted,
											fontSize: typography.fontSize.xs,
										}}
									>
										Page {currentPage} of {totalPages}
									</p>
									<button
										type="button"
										disabled={currentPage >= totalPages}
										onClick={() => {
											updateFilters({ pageDelta: 1 })
										}}
										css={secondaryButtonCss}
									>
										Next
									</button>
								</div>
							) : null
						}
						record={
							selectedMessage
								? renderAccountEmailDetail({
										onNavigate: (href) => {
											void router.navigate({ to: href })
										},
										selectedMessage,
										classifyState,
										deleteState,
										deleteArmed,
										onDeleteArm: () => setDeleteArmedId(selectedMessage.id),
										onDeleteReset: () => setDeleteArmedId(null),
										onClassify: (classification) => {
											void classifySelectedMessage(classification)
										},
										onDelete: () => {
											void deleteSelectedMessage()
										},
									})
								: null
						}
					/>
				</>
			) : null}
			{showUnverified ? (
				<>
					{data.inboxAddress ? (
						<p css={{ margin: 0 }}>
							Your inbox address will be <code>{data.inboxAddress}</code> after
							verification.
						</p>
					) : null}
					{renderEmailVerificationPrompt({
						email: data.email,
						description:
							'Verify your account email to browse stored messages. MCP access and email features stay locked until this account email is verified.',
						delivery: resendAccepted
							? acceptedEmailVerificationDelivery()
							: (session?.emailVerificationDelivery ?? null),
						resendStatus,
						resendMessage,
						resendTone,
						onResend: () => {
							void handleResendVerification()
						},
						secondaryHref: '/pending-verification',
						secondaryLabel: 'Verification page',
					})}
				</>
			) : null}
		</AccountManagementShell>
	)
}
