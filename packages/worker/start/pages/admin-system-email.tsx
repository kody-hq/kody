/** @jsxImportSource @emotion/react */
import { buildAdminEmailHtmlPreviewDocument } from '#client/email-html-preview.ts'
import { deleteAdminSystemEmail } from '#start/server/admin-mutations'
import { type AdminSystemEmailLoaderData } from '#universal/loader-data.ts'
import {
	cardCss,
	getDangerPillCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { css } from '@emotion/react'
import { useMutation } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { formatNullableTimestamp } from '../components/local-timestamp.tsx'
import { Tab, TabList, TabPanel, Tabs } from '../components/tabs.tsx'
import { usePageInvalidation } from '../page-invalidation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AdminPageHeader,
	MetadataGrid,
	TimestampValue,
} from './account-management-components.tsx'
import {
	RecordTable,
	recordBodyCss,
	recordCellClamp,
	recordStampCss,
} from './record-table.tsx'
const clampedCellCss = css(recordCellClamp(30))
const emailBodyPreCss = css({
	margin: 0,
	whiteSpace: 'pre-wrap',
	overflowX: 'auto',
})
const emailBodyEmptyCss = css({
	margin: 0,
	color: colors.textMuted,
})
const emailHtmlPreviewIframeCss = css({
	display: 'block',
	width: '100%',
	minHeight: '24rem',
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
	background: colors.surface,
})
function formatByteCount(value: number) {
	return new Intl.NumberFormat().format(value)
}
function messageHref(messageId: string) {
	return `/admin/system-email?messageId=${encodeURIComponent(messageId)}`
}
export function AdminSystemEmailPage({
	payload: data,
	currentHref,
}: {
	payload: AdminSystemEmailLoaderData
	currentHref: string
}) {
	const router = useRouter()
	const captureSubmitter = useSubmitterScope()
	const invalidate = usePageInvalidation(['loadAdminSystemEmail'])
	const mutation = useMutation({
		gcTime: 0,
		mutationFn: (input: { messageId: string }) =>
			deleteAdminSystemEmail({ data: input }),
		onMutate: () => invalidate,
		// A lost reply can follow a committed deletion. Reconcile the submitting actor.
		onSettled: (_data, _error, _input, reconcile) => reconcile?.(),
	})
	const [armedId, setArmedId] = useState<string | null>(null)
	const [message, setMessage] = useState<string | null>(null)
	const pending = mutation.isPending
	async function deleteMessage(id: string) {
		if (pending) return
		if (armedId !== id) {
			setArmedId(id)
			return
		}
		const isCurrent = captureSubmitter()
		setMessage(null)
		try {
			await mutation.mutateAsync({ messageId: id })
			if (!isCurrent()) return
			setArmedId(null)
			await router.navigate({ href: '/admin/system-email' })
		} catch (error) {
			if (!isCurrent()) return
			setArmedId(null)
			setMessage(
				error instanceof Error
					? error.message
					: 'Unable to delete system email.',
			)
		}
	}
	const totalPages = data
		? Math.max(1, Math.ceil(data.total / data.pageSize))
		: 1
	const selectedMessage = data?.selectedMessage ?? null
	return (
		<AccountManagementShell
			currentHref={currentHref}
			maxWidth="min(100%, 92rem)"
			busy={pending}
		>
			<AdminPageHeader
				title="Admin system email"
				description="Operator-owned inboxes for reserved platform addresses. These messages are not user account data."
				currentHref={currentHref}
			/>

			{message ? (
				<AccountManagementMessage tone="error">
					{message}
				</AccountManagementMessage>
			) : null}
			{data ? (
				<>
					<AccountManagementPanel
						title="System inbox messages"
						description={`Addresses: ${data.systemLocals
							.map((local) => `${local}@<platform domain>`)
							.join(
								', ',
							)}. Retention keeps ${data.limits.retentionDays} days and at most ${data.limits.maxStoredMessages} stored messages.`}
					>
						<RecordTable
							mode="expand"
							busy={pending}
							ariaLabel="System inbox messages"
							selectedId={selectedMessage?.id ?? null}
							countLabel={`${data.total} stored`}
							emptyLabel="No system mail has been stored."
							columns={[
								{ key: 'subject', label: 'Subject', primary: true },
								{ key: 'inbox', label: 'Inbox' },
								{ key: 'to', label: 'To', drop: 1 },
								{ key: 'from', label: 'From', drop: 1 },
								{ key: 'bytes', label: 'Bytes', align: 'end', drop: 2 },
								{ key: 'received', label: 'Received' },
							]}
							rows={data.messages.map((systemMessage) => ({
								id: systemMessage.id,
								href: messageHref(systemMessage.id),
								cells: {
									subject: (
										<span css={clampedCellCss}>
											{systemMessage.subject || '(no subject)'}
										</span>
									),
									inbox: systemMessage.inbox_local_part,
									to: (
										<span css={clampedCellCss}>
											{systemMessage.to_addresses.join(', ') || 'None'}
										</span>
									),
									from: (
										<span css={clampedCellCss}>
											{systemMessage.from_address ??
												systemMessage.envelope_from ??
												'Unknown'}
										</span>
									),
									bytes: formatByteCount(systemMessage.raw_size),
									received: (
										<span css={recordStampCss}>
											{formatNullableTimestamp(
												systemMessage.received_at ?? systemMessage.created_at,
												'Unknown',
											)}
										</span>
									),
								},
							}))}
							footer={
								totalPages > 1 ? (
									<p
										css={{
											margin: 0,
											textAlign: 'center',
											color: colors.textMuted,
											fontSize: typography.fontSize.xs,
										}}
									>
										Page {data.page} of {totalPages}
									</p>
								) : null
							}
							record={
								selectedMessage ? (
									<div css={recordBodyCss}>
										<div css={{ display: 'grid', gap: spacing.xs }}>
											<div
												css={{
													display: 'flex',
													flexWrap: 'wrap',
													gap: spacing.sm,
													alignItems: 'center',
													justifyContent: 'space-between',
												}}
											>
												<h2
													css={{
														margin: 0,
														fontSize: typography.fontSize.lg,
														fontWeight: typography.fontWeight.semibold,
														color: colors.text,
													}}
												>
													{selectedMessage.subject || '(no subject)'}
												</h2>
												<button
													type="button"
													css={getDangerPillCss({ size: 'sm' })}
													disabled={pending}
													aria-label={`${armedId === selectedMessage.id ? 'Confirm delete' : 'Delete'} message "${selectedMessage.subject || '(no subject)'}"`}
													title={
														armedId === selectedMessage.id
															? 'Click again to permanently delete this system email message'
															: 'Delete this system email message and its attachments'
													}
													onBlur={() => setArmedId(null)}
													onClick={() => void deleteMessage(selectedMessage.id)}
												>
													{pending
														? 'Deleting…'
														: armedId === selectedMessage.id
															? 'Confirm delete'
															: 'Delete'}
												</button>
											</div>
											<p
												css={{
													margin: 0,
													color: colors.textMuted,
												}}
											>
												Admin reads and deletes of message content are audit
												logged.
											</p>
										</div>
										<MetadataGrid
											items={[
												{
													label: 'Inbox',
													value: selectedMessage.inbox_local_part,
												},
												{
													label: 'From',
													value:
														selectedMessage.from_address ??
														selectedMessage.envelope_from ??
														'Unknown',
												},
												{
													label: 'Received',
													value: (
														<TimestampValue
															value={
																selectedMessage.received_at ??
																selectedMessage.created_at
															}
															fallback="Unknown"
														/>
													),
												},
												{
													label: 'To',
													value:
														selectedMessage.to_addresses.join(', ') || 'None',
												},
												{
													label: 'Reply-To',
													value:
														selectedMessage.reply_to_addresses.join(', ') ||
														'None',
												},
												{
													label: 'Attachments',
													value: String(selectedMessage.attachments.length),
												},
											]}
										/>
										<section css={cardCss}>
											<h3
												css={{
													margin: 0,
													fontSize: typography.fontSize.base,
												}}
											>
												Message body
											</h3>
											<Tabs defaultActiveTab="html">
												<TabList aria-label="Email body">
													<Tab name="html">HTML</Tab>
													<Tab name="text">Text</Tab>
													<Tab name="source">HTML Source</Tab>
												</TabList>
												<TabPanel name="html">
													{selectedMessage.html_body ? (
														<iframe
															title="Email HTML preview"
															sandbox=""
															referrerPolicy="no-referrer"
															srcDoc={buildAdminEmailHtmlPreviewDocument(
																selectedMessage.html_body,
															)}
															css={emailHtmlPreviewIframeCss}
														/>
													) : (
														<p css={emailBodyEmptyCss}>
															No HTML body exists for this message.
														</p>
													)}
												</TabPanel>
												<TabPanel name="text">
													{selectedMessage.text_body ? (
														<pre css={emailBodyPreCss}>
															{selectedMessage.text_body}
														</pre>
													) : (
														<p css={emailBodyEmptyCss}>
															No text exists in this tab content.
														</p>
													)}
												</TabPanel>
												<TabPanel name="source">
													{selectedMessage.html_body ? (
														<pre css={emailBodyPreCss}>
															{selectedMessage.html_body}
														</pre>
													) : (
														<p css={emailBodyEmptyCss}>
															No HTML body exists for this message.
														</p>
													)}
												</TabPanel>
											</Tabs>
										</section>
									</div>
								) : null
							}
						/>
					</AccountManagementPanel>
				</>
			) : null}
		</AccountManagementShell>
	)
}
