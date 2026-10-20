/** @jsxImportSource @emotion/react */
import { SiteLink } from '../components/site-link.tsx'
import { css } from '@emotion/react'
import { useRouter } from '@tanstack/react-router'
import { formatTimestamp } from '../components/local-timestamp.tsx'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	cardCss,
	getGhostButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	type AdminPlatformFeedbackLoaderData,
	type AdminPlatformFeedbackListItem,
} from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AdminPageHeader,
	IdValue,
	MetadataGrid,
	TimestampValue,
} from './account-management-components.tsx'
import {
	RecordTable,
	RecordTableSelect,
	recordBodyCss,
	recordCellClamp,
	recordStampCss,
} from './record-table.tsx'
type FeedbackFilterState = {
	status: string
	category: string
}
const statusOptions = [
	{ value: '', label: 'All statuses' },
	{ value: 'open', label: 'Open' },
	{ value: 'triaged', label: 'Triaged' },
	{ value: 'resolved', label: 'Resolved' },
	{ value: 'dismissed', label: 'Dismissed' },
] as const
const categoryOptions = [
	{ value: '', label: 'All categories' },
	{ value: 'friction', label: 'Friction' },
	{ value: 'bug', label: 'Bug' },
	{ value: 'experience', label: 'Experience' },
	{ value: 'suggestion', label: 'Suggestion' },
	{ value: 'cancellation', label: 'Cancellation' },
	{ value: 'other', label: 'Other' },
] as const
const summaryPreviewCss = css(recordCellClamp(32))
const untrustedTextCss = css({
	margin: 0,
	whiteSpace: 'pre-wrap',
	overflowWrap: 'anywhere',
	fontFamily: 'inherit',
})
function readFilterState(href: string): FeedbackFilterState {
	const url = new URL(href, 'http://localhost')
	return {
		status: url.searchParams.get('status')?.trim() ?? '',
		category: url.searchParams.get('category')?.trim() ?? '',
	}
}
function readSelectedFeedbackId(href: string) {
	return new URL(href, 'http://localhost').searchParams.get('feedbackId')
}
function buildFeedbackHref(currentHref: string, feedbackId: string) {
	const url = new URL(currentHref, 'http://localhost')
	url.searchParams.set('feedbackId', feedbackId)
	return routes.adminPlatformFeedback.href(null, {
		searchParams: url.searchParams,
	})
}
function buildPageHref(currentHref: string, page: number) {
	const url = new URL(currentHref, 'http://localhost')
	url.searchParams.delete('feedbackId')
	if (page <= 1) url.searchParams.delete('page')
	else url.searchParams.set('page', String(page))
	return routes.adminPlatformFeedback.href(null, {
		searchParams: url.searchParams,
	})
}
function buildHrefWithUpdatedFilters(
	currentHref: string,
	nextFilters: Partial<FeedbackFilterState>,
) {
	const url = new URL(currentHref, 'http://localhost')
	const filters = { ...readFilterState(url.toString()), ...nextFilters }
	if (filters.status) url.searchParams.set('status', filters.status)
	else url.searchParams.delete('status')
	if (filters.category) url.searchParams.set('category', filters.category)
	else url.searchParams.delete('category')
	// Filter changes re-anchor the list and clear the detail selection.
	url.searchParams.delete('feedbackId')
	url.searchParams.delete('page')
	return routes.adminPlatformFeedback.href(null, {
		searchParams: url.searchParams,
	})
}
function feedbackTitle(feedback: AdminPlatformFeedbackListItem) {
	return `${feedback.category}: ${feedback.summary_untrusted}`
}
export function AdminPlatformFeedbackPage({
	payload: data,
	currentHref,
}: {
	payload: AdminPlatformFeedbackLoaderData
	currentHref: string
}) {
	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
	const pending = false
	const message = null
	const status: string = 'ready'
	const router = useRouter()
	const replaceLocation = (href: string) =>
		void router.navigate({ href, replace: true })
	const selectedFeedback = data.selectedFeedback
	const selectedFeedbackId = readSelectedFeedbackId(currentHref)
	const filters = readFilterState(currentHref)
	const totalPages = data
		? Math.max(1, Math.ceil(data.total / data.pageSize))
		: 1
	const hasActiveFilters = Boolean(filters.status || filters.category)
	return (
		<AccountManagementShell
			currentHref={currentHref}
			maxWidth="min(100%, 92rem)"
			busy={pending}
		>
			<AdminPageHeader
				title="Platform feedback"
				description="Read attributed feedback that users explicitly approved for admin review."
				currentHref={currentHref}
			/>

			{status === 'loading' ? (
				<p css={{ color: colors.textMuted, margin: 0 }}>
					Loading platform feedback…
				</p>
			) : null}
			{message ? (
				<AccountManagementMessage tone={status === 'error' ? 'error' : 'info'}>
					{message}
				</AccountManagementMessage>
			) : null}

			{data ? (
				<RecordTable
					mode="expand"
					busy={pending}
					ariaLabel="Platform feedback queue"
					selectedId={selectedFeedbackId}
					countLabel={`${data.total} submission${data.total === 1 ? '' : 's'}`}
					emptyLabel="No platform feedback matches this view."
					toolbar={
						<>
							<RecordTableSelect
								label="Filter feedback by status"
								value={filters.status}
								onChange={(value) => {
									replaceLocation(
										buildHrefWithUpdatedFilters(currentHref, {
											status: value,
										}),
									)
								}}
							>
								{statusOptions.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</RecordTableSelect>
							<RecordTableSelect
								label="Filter feedback by category"
								value={filters.category}
								onChange={(value) => {
									replaceLocation(
										buildHrefWithUpdatedFilters(currentHref, {
											category: value,
										}),
									)
								}}
							>
								{categoryOptions.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</RecordTableSelect>
							{hasActiveFilters ? (
								<button
									type="button"
									onClick={() => {
										replaceLocation(
											buildHrefWithUpdatedFilters(currentHref, {
												status: '',
												category: '',
											}),
										)
									}}
									css={secondaryButtonCss}
								>
									Clear filters
								</button>
							) : null}
						</>
					}
					columns={[
						{ key: 'category', label: 'Category', primary: true },
						{ key: 'summary', label: 'Summary', drop: 1 },
						{ key: 'status', label: 'Status' },
						{ key: 'id', label: 'Feedback id', drop: 3 },
						{ key: 'created', label: 'Created' },
					]}
					rows={data.feedback.map((feedback) => ({
						id: feedback.id,
						href: buildFeedbackHref(currentHref, feedback.id),
						cells: {
							category: feedback.category,
							summary: feedback.summary_untrusted ? (
								<span css={summaryPreviewCss}>
									{feedback.summary_untrusted}
								</span>
							) : null,
							status: feedback.status,
							id: (
								<code
									css={{
										fontSize: '0.8rem',
										color: colors.textMuted,
										whiteSpace: 'nowrap',
									}}
								>
									{feedback.id}
								</code>
							),
							created: (
								<span css={recordStampCss}>
									{formatTimestamp(feedback.created_at)}
								</span>
							),
						},
					}))}
					footer={
						totalPages > 1 ? (
							<nav
								aria-label="Feedback pages"
								css={{
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'center',
									gap: spacing.sm,
									flexWrap: 'wrap',
								}}
							>
								{data.page > 1 ? (
									<SiteLink
										href={buildPageHref(currentHref, data.page - 1)}
										css={{
											...secondaryButtonCss,
											textDecoration: 'none',
										}}
									>
										Previous
									</SiteLink>
								) : null}
								<span
									css={{
										color: colors.textMuted,
										fontSize: typography.fontSize.xs,
									}}
								>
									Page {data.page} of {totalPages}
								</span>
								{data.page < totalPages ? (
									<SiteLink
										href={buildPageHref(currentHref, data.page + 1)}
										css={{
											...secondaryButtonCss,
											textDecoration: 'none',
										}}
									>
										Next
									</SiteLink>
								) : null}
							</nav>
						) : null
					}
					record={
						selectedFeedback ? (
							<div css={recordBodyCss}>
								<div css={{ display: 'grid', gap: spacing.xs }}>
									<h2
										css={{
											margin: 0,
											fontSize: typography.fontSize.lg,
											fontWeight: typography.fontWeight.semibold,
											color: colors.text,
										}}
									>
										{feedbackTitle(selectedFeedback)}
									</h2>
									<p css={{ margin: 0, color: colors.textMuted }}>
										This detail read is audit logged.
									</p>
								</div>

								<MetadataGrid
									items={[
										{
											label: 'Submitter username',
											value:
												selectedFeedback.submitter?.username ??
												'Account unavailable',
										},
										{
											label: 'Submitter email',
											value:
												selectedFeedback.submitter?.email ??
												'Account unavailable',
										},
										{
											label: 'Stable user ID',
											value: (
												<IdValue
													value={
														selectedFeedback.submitter?.user_id ??
														selectedFeedback.submitter_user_id
													}
													label="stable user ID"
												/>
											),
										},
										{
											label: 'Category',
											value: selectedFeedback.category,
										},
										{
											label: 'Status',
											value: selectedFeedback.status,
										},
										{
											label: 'Created',
											value: (
												<TimestampValue value={selectedFeedback.created_at} />
											),
										},
										{
											label: 'Updated',
											value: (
												<TimestampValue value={selectedFeedback.updated_at} />
											),
										},
										{
											label: 'Reviewed',
											value: (
												<TimestampValue
													value={selectedFeedback.reviewed_at}
													fallback="Never"
												/>
											),
										},
										{
											label: 'Reviewer ID',
											value: selectedFeedback.reviewed_by_user_id ? (
												<IdValue
													value={selectedFeedback.reviewed_by_user_id}
													label="reviewer ID"
												/>
											) : (
												'None'
											),
										},
									]}
								/>

								<section css={cardCss}>
									<strong>Summary (untrusted)</strong>
									<pre css={untrustedTextCss}>
										{selectedFeedback.summary_untrusted}
									</pre>
								</section>
								<section css={cardCss}>
									<strong>Details (untrusted)</strong>
									<pre css={untrustedTextCss}>
										{selectedFeedback.details_untrusted}
									</pre>
								</section>
								<section css={cardCss}>
									<strong>Admin note</strong>
									{selectedFeedback.admin_note ? (
										<pre css={untrustedTextCss}>
											{selectedFeedback.admin_note}
										</pre>
									) : (
										<p css={{ margin: 0, color: colors.textMuted }}>
											No admin note.
										</p>
									)}
								</section>
								<section css={cardCss}>
									<strong>Resolution note</strong>
									<p
										css={{
											margin: '0 0 0.5rem',
											color: colors.textMuted,
											fontSize: typography.fontSize.sm,
										}}
									>
										Shown to the submitter on resolve or dismiss. Separate from
										the internal admin note.
									</p>
									{selectedFeedback.resolution_note ? (
										<pre css={untrustedTextCss}>
											{selectedFeedback.resolution_note}
										</pre>
									) : (
										<p css={{ margin: 0, color: colors.textMuted }}>
											No resolution note.
										</p>
									)}
								</section>
								<section css={cardCss}>
									<strong>Resolution PR URLs</strong>
									{selectedFeedback.resolution_pr_urls.length > 0 ? (
										<ul
											css={{
												margin: 0,
												paddingLeft: '1.25rem',
												display: 'grid',
												gap: spacing.xs,
											}}
										>
											{selectedFeedback.resolution_pr_urls.map((url) => (
												<li key={url}>
													<a
														href={url}
														target="_blank"
														rel="noreferrer"
														css={{
															color: colors.primaryText,
															overflowWrap: 'anywhere',
														}}
													>
														{url}
													</a>
												</li>
											))}
										</ul>
									) : (
										<p css={{ margin: 0, color: colors.textMuted }}>
											No resolution PR URLs.
										</p>
									)}
								</section>
							</div>
						) : null
					}
				/>
			) : null}
		</AccountManagementShell>
	)
}
