/** @jsxImportSource @emotion/react */
import { useEffect, useRef, useId } from 'react'
import { type CSSObject } from '@emotion/react'
import { CopyTextButton } from '../components/copy-text-button.tsx'
import { formatTimestampDate } from '../components/local-timestamp.tsx'
import { type AccountPackageSecurityAudit } from '#universal/loader-data.ts'
import { packageSecurityAuditAnchor } from '#universal/package-security-audit-prompt.ts'
import { communityStatusPillBoxCss } from '#universal/community-status-pill.ts'
import {
	getGhostButtonCss,
	hoverMq,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'

export function auditedLabel(audit: { recordedAt: string; auditor: string }) {
	return (
		<>
			Audited {formatTimestampDate(audit.recordedAt)} by {audit.auditor}
		</>
	)
}

/**
 * Informational audit of the exact published commit + capability set. It
 * never approves anything; the Approve button stays a separate human click.
 */
export function PackageSecurityAuditField({
	audit,
	packageName,
	hasPausedPublish,
}: {
	audit: AccountPackageSecurityAudit
	packageName: string
	hasPausedPublish: boolean
}) {
	const dialog = useRef<HTMLDialogElement>(null)
	const dialogTitleId = useId()
	function openDialog() {
		if (dialog.current && !dialog.current.open) dialog.current.showModal()
	}
	function closeDialog() {
		dialog.current?.close()
	}
	useEffect(() => {
		if (
			audit.status === 'audited' &&
			window.location.hash === `#${packageSecurityAuditAnchor}`
		)
			openDialog()
	}, [audit.status])

	return (
		<section
			id={packageSecurityAuditAnchor}
			data-testid="package-security-audit"
			data-audit-status={audit.status}
			aria-labelledby="package-security-audit-heading"
			css={fieldCss}
		>
			<h2 id="package-security-audit-heading" css={fieldLabelCss}>
				Security audit
			</h2>
			{audit.status === 'unpublished' ? (
				<p css={fieldValueCss}>
					No security audit performed. Publish this package to audit it.
				</p>
			) : audit.status === 'not_audited' ? (
				<button
					type="button"
					data-testid="package-security-audit-open"
					aria-haspopup="dialog"
					css={linkButtonCss}
					onClick={openDialog}
				>
					No security audit performed
				</button>
			) : (
				<p css={auditedRowCss}>
					<span
						data-testid="package-security-audit-verdict"
						css={audit.verdict === 'pass' ? passPillCss : concernsPillCss}
					>
						{audit.verdict === 'pass' ? 'Pass' : 'Concerns'}
					</span>
					<a
						href={`#${packageSecurityAuditAnchor}`}
						data-testid="package-security-audit-open"
						aria-haspopup="dialog"
						css={linkButtonCss}
						onClick={(event) => {
							event.preventDefault()
							openDialog()
						}}
					>
						{auditedLabel(audit)}
					</a>
				</p>
			)}
			{hasPausedPublish && audit.status !== 'unpublished' ? (
				<p data-testid="package-security-audit-paused-note" css={fieldNoteCss}>
					Covers the published version only, not the paused publish waiting
					above. Audit that one after it publishes.
				</p>
			) : null}
			<p css={fieldNoteCss}>
				{audit.status === 'audited'
					? 'Informational only. It covers this published version; a new publish or capability change needs a new audit.'
					: 'Informational only. Have your agent review this version before you approve. It never approves anything for you.'}
			</p>
			{audit.status === 'unpublished' ? null : (
				<dialog
					aria-labelledby={dialogTitleId}
					data-testid="package-security-audit-dialog"
					css={dialogCss}
					ref={dialog}
					onCancel={(event) => {
						event.preventDefault()
						closeDialog()
					}}
					onClick={(event) => {
						if (event.target === event.currentTarget) closeDialog()
					}}
				>
					<div css={dialogBodyCss}>
						{audit.status === 'not_audited' ? (
							<>
								<h3 id={dialogTitleId} css={dialogTitleCss}>
									Ask your agent for a security audit
								</h3>
								<p css={dialogTextCss}>
									Copy this prompt into your agent. It reviews this exact
									version of {packageName} and records the result here. The
									audit is informational; you still approve yourself.
								</p>
								<pre
									data-testid="package-security-audit-prompt"
									css={promptCss}
								>
									{audit.prompt}
								</pre>
								<div css={dialogActionsCss}>
									<CopyTextButton
										value={audit.prompt}
										idleLabel="Copy prompt"
										ariaLabel="Copy security audit prompt"
										variant="pill"
										size="sm"
									/>
									<button
										type="button"
										data-testid="package-security-audit-close"
										css={getGhostButtonCss()}
										onClick={closeDialog}
									>
										Close
									</button>
								</div>
							</>
						) : (
							<>
								<h3 id={dialogTitleId} css={dialogTitleCss}>
									Security audit summary
								</h3>
								<p css={dialogTextCss}>
									{auditedLabel(audit)}
									{audit.recordedBy ? ` · recorded by ${audit.recordedBy}` : ''}
									{' · '}
									{audit.verdict === 'pass'
										? 'No concerns found'
										: 'Concerns found'}
								</p>
								<p
									data-testid="package-security-audit-summary"
									css={summaryCss}
								>
									{audit.summary}
								</p>
								<div css={dialogActionsCss}>
									<button
										type="button"
										data-testid="package-security-audit-close"
										css={getGhostButtonCss()}
										onClick={closeDialog}
									>
										Close
									</button>
								</div>
							</>
						)}
					</div>
				</dialog>
			)}
		</section>
	)
}

const fieldCss: CSSObject = {
	display: 'grid',
	gap: spacing.xs,
	padding: spacing.md,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.surface,
	minWidth: 0,
}

const fieldLabelCss: CSSObject = {
	margin: 0,
	fontSize: typography.fontSize.sm,
	fontWeight: typography.fontWeight.semibold,
	color: colors.textMuted,
	letterSpacing: '0.01em',
}

const fieldValueCss: CSSObject = {
	margin: 0,
	color: colors.text,
	fontSize: typography.fontSize.base,
}

const fieldNoteCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const linkButtonCss: CSSObject = {
	appearance: 'none' as const,
	justifySelf: 'start',
	padding: 0,
	border: 'none',
	background: 'none',
	font: 'inherit',
	fontSize: typography.fontSize.base,
	fontWeight: typography.fontWeight.semibold,
	color: colors.primaryText,
	textAlign: 'start' as const,
	textDecoration: 'underline',
	textUnderlineOffset: '0.2em',
	cursor: 'pointer',
	overflowWrap: 'anywhere' as const,
	[hoverMq]: {
		'&:hover': { color: colors.primaryHover },
	},
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '2px',
		borderRadius: radius.sm,
	},
}

const auditedRowCss: CSSObject = {
	margin: 0,
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	gap: spacing.sm,
	minWidth: 0,
}

const passPillCss: CSSObject = {
	...communityStatusPillBoxCss,
	color: colors.primaryText,
	backgroundColor: colors.primarySoft,
}

const concernsPillCss: CSSObject = {
	...communityStatusPillBoxCss,
	color: colors.warningText,
	backgroundColor: 'color-mix(in srgb, var(--color-warning) 18%, transparent)',
}

const dialogCss: CSSObject = {
	width: 'min(40rem, calc(100vw - 2rem))',
	maxWidth: '40rem',
	padding: 0,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.lg,
	boxShadow: shadows.md,
	backgroundColor: colors.surface,
	color: colors.text,
	'&::backdrop': {
		backgroundColor: 'oklch(0 0 0 / 0.45)',
	},
}

const dialogBodyCss: CSSObject = {
	display: 'grid',
	gap: spacing.md,
	padding: spacing.lg,
	minWidth: 0,
}

const dialogTitleCss: CSSObject = {
	margin: 0,
	fontSize: '1.2rem',
	fontWeight: 720,
	letterSpacing: '-0.014em',
	lineHeight: 1.2,
}

const dialogTextCss: CSSObject = {
	margin: 0,
	color: colors.textMuted,
}

const promptCss: CSSObject = {
	margin: 0,
	maxHeight: 'min(22rem, 45vh)',
	overflow: 'auto',
	padding: spacing.md,
	borderRadius: radius.md,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.background,
	fontFamily: typography.fontFamilyMono,
	fontSize: typography.fontSize.sm,
	lineHeight: 1.5,
	whiteSpace: 'pre-wrap' as const,
	overflowWrap: 'anywhere' as const,
}

const summaryCss: CSSObject = {
	margin: 0,
	whiteSpace: 'pre-wrap' as const,
	overflowWrap: 'anywhere' as const,
	lineHeight: 1.55,
}

const dialogActionsCss: CSSObject = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
	alignItems: 'center',
}
