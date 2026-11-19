/** @jsxImportSource @emotion/react */
import { Badge } from '../components/badge.tsx'
import { Button } from '../components/button.tsx'
import { SiteLink } from '../components/site-link.tsx'
import type { CSSObject } from '@emotion/react'
import { buildCredentialApprovalHref } from '#universal/credential-contracts.ts'
import {
	buildAdminEmailHtmlPreviewDocument,
	emailHtmlPreviewSandbox,
} from '#client/email-html-preview.ts'
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
import type { EmailClassification } from '#universal/email-message-view.ts'
import type { AccountEmailMessageDetail } from '#universal/loader-data.ts'
import { EmailTriageBadges } from './email-triage-controls.tsx'
import {
	type ClassifyState,
	type DeleteState,
	directionLabel,
	messageDate,
	senderClassificationLabel,
} from './account-email-shared.ts'
import { Input, Select } from '../components/input.tsx'

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
	onTriage: (input: {
		classification?: EmailClassification
		archived?: boolean
	}) => void
	/** Shown only after this person marks the message as spam. */
	blockOffer: boolean
	blockState: 'idle' | 'blocking'
	onBlockSender: () => void
	onDismissBlockOffer: () => void
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
		onTriage,
		blockOffer,
		blockState,
		onBlockSender,
		onDismissBlockOffer,
		onDelete,
	} = props
	const isMutating =
		classifyState !== 'idle' || deleteState !== 'idle' || blockState !== 'idle'
	const classification = selectedMessage.classification

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
					<EmailTriageBadges
						classification={classification}
						classificationReason={selectedMessage.classification_reason}
						archivedAt={selectedMessage.archived_at}
					/>
					{senderClassificationLabel(selectedMessage.sender_classification) ? (
						<Badge
							title={selectedMessage.sender_classification_reason ?? undefined}
						>
							{senderClassificationLabel(selectedMessage.sender_classification)}
						</Badge>
					) : null}
				</div>
				<p css={{ margin: 0, color: colors.textMuted }}>
					{directionLabel(selectedMessage.direction)} message
				</p>
				{classification !== 'accepted' &&
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
				{selectedMessage.direction === 'inbound' &&
				classification !== 'accepted' ? (
					<Button
						type="button"
						disabled={isMutating}
						onClick={() => {
							onTriage({ classification: 'accepted' })
						}}
						variant="secondary"
					>
						{classifyState === 'saving' ? 'Updating…' : 'Not spam'}
					</Button>
				) : null}
				{selectedMessage.direction === 'inbound' &&
				classification !== 'spam' ? (
					<Button
						type="button"
						disabled={isMutating}
						onClick={() => {
							onTriage({ classification: 'spam' })
						}}
						variant="danger"
					>
						{classifyState === 'saving' ? 'Updating…' : 'Mark as spam'}
					</Button>
				) : null}
				{selectedMessage.direction === 'inbound' ? (
					<Button
						type="button"
						disabled={isMutating}
						onClick={() => {
							onTriage({ archived: !selectedMessage.archived_at })
						}}
						variant="secondary"
					>
						{selectedMessage.archived_at ? 'Unarchive' : 'Archive'}
					</Button>
				) : null}
				<Button
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
					variant="danger"
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
				</Button>
			</div>
			{blockOffer &&
			classification === 'spam' &&
			selectedMessage.from_address ? (
				<div
					role="status"
					css={{
						display: 'flex',
						flexWrap: 'wrap',
						gap: spacing.sm,
						alignItems: 'center',
						padding: spacing.sm,
						border: `1px solid ${colors.border}`,
						borderRadius: radius.md,
						background: colors.primarySoftest,
					}}
				>
					<span>
						Also block future mail from{' '}
						<code css={{ overflowWrap: 'anywhere' }}>
							{selectedMessage.from_address}
						</code>
						?
					</span>
					<Button
						type="button"
						disabled={isMutating}
						onClick={onBlockSender}
						variant="secondary"
					>
						{blockState === 'blocking' ? 'Blocking…' : 'Block sender'}
					</Button>
					<Button
						type="button"
						disabled={isMutating}
						onClick={onDismissBlockOffer}
						variant="secondary"
					>
						No thanks
					</Button>
				</div>
			) : null}
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
						<Select
							size="sm"
							name="kodyId"
							aria-label="Package to enable for this sender"
						>
							{selectedMessage.enable_sender.packages.map((pkg) => (
								<option key={pkg.kody_id} value={pkg.kody_id}>
									{pkg.kody_id}
								</option>
							))}
						</Select>
					) : (
						<Input
							size="sm"
							name="kodyId"
							required
							aria-label="Package to enable for this sender"
							placeholder="Package name"
						/>
					)}
					<Button type="submit" variant="secondary">
						Enable a package for this sender
					</Button>
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
						label: 'Archived',
						value: selectedMessage.archived_at ? (
							<TimestampValue
								value={selectedMessage.archived_at}
								fallback="No"
							/>
						) : (
							'No'
						),
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
								sandbox={emailHtmlPreviewSandbox}
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
