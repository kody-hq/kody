/** @jsxImportSource @emotion/react */
import { SiteLink } from '../components/site-link.tsx'
import { type CSSObject } from '@emotion/react'
import { buildCredentialApprovalHref } from '#universal/credential-contracts.ts'
import { buildAdminEmailHtmlPreviewDocument } from '#client/email-html-preview.ts'
import { formatNullableTimestamp } from '../components/local-timestamp.tsx'

import { Tab, TabList, TabPanel, Tabs } from '../components/tabs.tsx'
import {
	MetadataGrid,
	TimestampValue,
} from './account-management-components.tsx'
import { recordBodyCss } from './record-table.tsx'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getDangerPillCss,
	getGhostButtonCss,
} from '#universal/styles/style-primitives.ts'
import { type AccountEmailMessageDetail } from '#universal/loader-data.ts'
import {
	type ClassifyState,
	type DeleteState,
	directionLabel,
	messageDate,
	quarantinedBadgeCss,
	senderBadgeCss,
	senderClassificationLabel,
} from './account-email-shared.ts'

const emailBodyPreCss: CSSObject = {
	margin: 0,
	whiteSpace: 'pre-wrap',
	overflowX: 'auto',
}

const emailBodyEmptyCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
}

const emailHtmlPreviewIframeCss: CSSObject = {
	display: 'block',
	width: '100%',
	minHeight: '24rem',
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
	background: colors.surface,
}

export type AccountEmailDetailProps = {
	selectedMessage: AccountEmailMessageDetail
	classifyState: ClassifyState
	deleteState: DeleteState
	deleteArmed: boolean
	onDeleteArm: () => void
	onDeleteReset: () => void
	onClassify: (classification: 'accepted' | 'quarantined') => void
	onNavigate: (href: string) => void
	onDelete: () => void
}

export function renderAccountEmailDetail(props: AccountEmailDetailProps) {
	const {
		selectedMessage,
		classifyState,
		deleteState,
		deleteArmed,
		onDeleteArm,
		onDeleteReset,
		onClassify,
		onDelete,
	} = props
	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
	const dangerButtonCss = getDangerPillCss({ size: 'sm' })
	const isMutating = classifyState !== 'idle' || deleteState !== 'idle'

	return (
		<div css={recordBodyCss}>
			<div css={{ display: 'grid', gap: spacing.xs }}>
				<div
					css={{
						display: 'flex',
						flexWrap: 'wrap',
						gap: spacing.sm,
						alignItems: 'center',
					}}
				>
					<h2
						css={{
							margin: 0,
							fontSize: typography.fontSize.lg,
							fontWeight: typography.fontWeight.semibold,
							color: colors.text,
							overflowWrap: 'anywhere',
						}}
					>
						{selectedMessage.subject || '(no subject)'}
					</h2>
					{selectedMessage.classification === 'quarantined' ? (
						<span
							title={selectedMessage.classification_reason ?? 'Quarantined'}
							css={quarantinedBadgeCss}
						>
							Quarantined
						</span>
					) : null}
					{senderClassificationLabel(selectedMessage.sender_classification) ? (
						<span
							title={selectedMessage.sender_classification_reason ?? undefined}
							css={senderBadgeCss}
						>
							{senderClassificationLabel(selectedMessage.sender_classification)}
						</span>
					) : null}
				</div>
				<p css={{ margin: 0, color: colors.textMuted }}>
					{directionLabel(selectedMessage.direction)} message
				</p>
				{selectedMessage.classification === 'quarantined' &&
				selectedMessage.classification_reason ? (
					<p
						css={{
							margin: 0,
							color: colors.textMuted,
							fontSize: typography.fontSize.sm,
						}}
					>
						{selectedMessage.classification_reason}
					</p>
				) : null}
			</div>
			<div
				css={{
					display: 'flex',
					flexWrap: 'wrap',
					gap: spacing.sm,
				}}
			>
				{selectedMessage.direction === 'inbound' ? (
					selectedMessage.classification === 'quarantined' ? (
						<button
							type="button"
							disabled={isMutating}
							onClick={() => {
								onClassify('accepted')
							}}
							css={secondaryButtonCss}
						>
							{classifyState === 'saving' ? 'Updating…' : 'Not spam'}
						</button>
					) : (
						<button
							type="button"
							disabled={isMutating}
							onClick={() => {
								onClassify('quarantined')
							}}
							css={dangerButtonCss}
						>
							{classifyState === 'saving' ? 'Updating…' : 'Mark as spam'}
						</button>
					)
				) : null}
				<button
					type="button"
					disabled={isMutating}
					aria-label={
						deleteArmed
							? `Confirm delete message "${selectedMessage.subject || '(no subject)'}"`
							: `Delete message "${selectedMessage.subject || '(no subject)'}"`
					}
					title={
						deleteArmed
							? 'Click again to permanently delete this message'
							: 'Delete this message and free a stored-message slot'
					}
					css={dangerButtonCss}
					onBlur={onDeleteReset}
					onClick={() => {
						if (deleteArmed) onDelete()
						else onDeleteArm()
					}}
				>
					{deleteState === 'deleting'
						? 'Deleting…'
						: deleteArmed
							? 'Confirm delete'
							: 'Delete'}
				</button>
			</div>
			{selectedMessage.enable_sender ? (
				<form
					onSubmit={(event) => {
						event.preventDefault()
						const form = event.currentTarget
						if (!(form instanceof HTMLFormElement)) return
						const kodyId = new FormData(form).get('kodyId')
						if (typeof kodyId !== 'string' || !kodyId.trim()) return
						const enableSender = selectedMessage.enable_sender
						if (!enableSender) return
						props.onNavigate(
							buildCredentialApprovalHref({
								username: enableSender.org_slug,
								kodyId: kodyId.trim(),
								changes: [],
								enable: [{ kind: 'subscription', name: enableSender.topic }],
								sender: enableSender.sender,
							}),
						)
					}}
					css={{
						display: 'flex',
						flexWrap: 'wrap',
						gap: spacing.sm,
						alignItems: 'center',
					}}
				>
					{selectedMessage.enable_sender.packages.length > 0 ? (
						<select
							name="kodyId"
							aria-label="Package to enable for this sender"
							css={{
								fontSize: typography.fontSize.sm,
								color: colors.text,
							}}
						>
							{selectedMessage.enable_sender.packages.map((pkg) => (
								<option key={pkg.kody_id} value={pkg.kody_id}>
									{pkg.kody_id}
								</option>
							))}
						</select>
					) : (
						<input
							name="kodyId"
							required
							aria-label="Package to enable for this sender"
							placeholder="Package name"
							css={{
								fontSize: typography.fontSize.sm,
								color: colors.text,
							}}
						/>
					)}
					<button type="submit" css={secondaryButtonCss}>
						Enable a package for this sender
					</button>
					<SiteLink
						href={selectedMessage.enable_sender.packages_href}
						css={{
							color: colors.textMuted,
							fontSize: typography.fontSize.sm,
						}}
					>
						Browse packages
					</SiteLink>
				</form>
			) : selectedMessage.direction === 'inbound' &&
			  selectedMessage.sender_classification === 'unverified' ? (
				<p
					css={{
						margin: 0,
						color: colors.textMuted,
						fontSize: typography.fontSize.sm,
					}}
				>
					Packages cannot run for an unverified sender.
				</p>
			) : null}
			<MetadataGrid
				items={[
					{
						label: 'From',
						value:
							selectedMessage.from_address ??
							selectedMessage.envelope_from ??
							'Unknown',
					},
					{
						label: 'To',
						value: selectedMessage.to_addresses.join(', ') || 'None',
					},
					{
						label: 'Date',
						value: (
							<TimestampValue
								value={messageDate(selectedMessage)}
								fallback="Unknown"
							/>
						),
					},
					{
						label: 'Direction',
						value: directionLabel(selectedMessage.direction),
					},
					{
						label: 'Processing',
						value: selectedMessage.processing_status,
					},
					{
						label: 'Delivery',
						value: selectedMessage.delivery_status ?? 'None',
					},
					{
						label: 'Classification',
						value: selectedMessage.classification,
					},
					{
						label: 'CC',
						value: selectedMessage.cc_addresses.join(', ') || 'None',
					},
					{
						label: 'Reply-To',
						value: selectedMessage.reply_to_addresses.join(', ') || 'None',
					},
					{
						label: 'Attachments',
						value: String(selectedMessage.attachments.length),
					},
				]}
			/>
			{selectedMessage.attachments.length > 0 ? (
				<section css={{ display: 'grid', gap: spacing.sm }}>
					<h3
						css={{
							margin: 0,
							fontSize: typography.fontSize.base,
						}}
					>
						Attachments
					</h3>
					<ul
						css={{
							margin: 0,
							paddingLeft: spacing.lg,
							display: 'grid',
							gap: spacing.xs,
						}}
					>
						{selectedMessage.attachments.map((attachment) => (
							<li key={attachment.id}>
								{attachment.filename || '(unnamed)'}
								{attachment.content_type ? ` · ${attachment.content_type}` : ''}
								{attachment.size != null ? ` · ${attachment.size} bytes` : ''}
							</li>
						))}
					</ul>
				</section>
			) : null}
			<section css={{ display: 'grid', gap: spacing.sm }}>
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
							<pre css={emailBodyPreCss}>{selectedMessage.text_body}</pre>
						) : (
							<p css={emailBodyEmptyCss}>
								No text body exists for this message.
							</p>
						)}
					</TabPanel>
					<TabPanel name="source">
						{selectedMessage.html_body ? (
							<pre css={emailBodyPreCss}>{selectedMessage.html_body}</pre>
						) : (
							<p css={emailBodyEmptyCss}>
								No HTML body exists for this message.
							</p>
						)}
					</TabPanel>
				</Tabs>
			</section>
			{selectedMessage.delivery_events.length > 0 ? (
				<section css={{ display: 'grid', gap: spacing.sm }}>
					<h3
						css={{
							margin: 0,
							fontSize: typography.fontSize.base,
						}}
					>
						Delivery events
					</h3>
					<ul
						css={{
							margin: 0,
							paddingLeft: spacing.lg,
							display: 'grid',
							gap: spacing.xs,
						}}
					>
						{selectedMessage.delivery_events.map((event) => (
							<li key={event.id}>
								{event.event_type} ·{' '}
								{formatNullableTimestamp(event.created_at, 'Unknown')}
								{event.provider ? ` · ${event.provider}` : ''}
							</li>
						))}
					</ul>
				</section>
			) : null}
		</div>
	)
}
