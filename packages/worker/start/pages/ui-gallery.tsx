/** @jsxImportSource @emotion/react */
import type { ReactNode } from 'react'
import { Button } from '../components/button.tsx'
import { renderIcon } from '../components/icon.tsx'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import type {
	ButtonSize,
	ButtonVariant,
} from '#universal/styles/style-primitives.ts'

const variants: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'danger']
const sizes: ButtonSize[] = ['xs', 'sm', 'md', 'lg']

/**
 * One section per shared component. `npm run ui:verify` screenshots, scans,
 * and keyboard-tests each `[data-ui-gallery-section]`, so a new component only
 * needs an entry here (and a heading in docs/contributing/ui-components.md).
 */
const uiGallerySections: ReadonlyArray<{
	id: string
	title: string
	render: () => ReactNode
}> = [
	{
		id: 'button',
		title: 'Button',
		render: () => (
			<>
				{variants.map((variant) => (
					<GalleryRow key={variant} label={variant}>
						{sizes.map((size) => (
							<Button key={size} type="button" variant={variant} size={size}>
								{`${variant} ${size}`}
							</Button>
						))}
						<Button type="button" variant={variant} disabled>
							Disabled
						</Button>
						<Button
							type="button"
							variant={variant}
							iconOnly
							aria-label={`Add (${variant})`}
						>
							{renderIcon('plus')}
						</Button>
					</GalleryRow>
				))}
				<GalleryRow label="link">
					<Button href="/docs" variant="primary">
						Primary link
					</Button>
					<Button href="/docs" variant="secondary">
						Secondary link
					</Button>
				</GalleryRow>
			</>
		),
	},
]

export function UiGalleryPage() {
	return (
		<main css={pageCss}>
			<header css={{ display: 'grid', gap: spacing.xs }}>
				<h1 css={{ margin: 0, fontFamily: typography.fontFamilyDisplay }}>
					UI gallery
				</h1>
				<p css={{ margin: 0, color: colors.textMuted }}>
					Every shared component in every variant, size, and state. Dev and
					preview only. The color scheme follows your system setting;{' '}
					<code>npm run ui:verify</code> renders both.
				</p>
			</header>
			<nav aria-label="Components">
				<ul css={tocCss}>
					{uiGallerySections.map((section) => (
						<li key={section.id}>
							<a href={`#${section.id}`}>{section.title}</a>
						</li>
					))}
				</ul>
			</nav>
			{uiGallerySections.map((section) => (
				<section
					key={section.id}
					id={section.id}
					data-ui-gallery-section={section.id}
					aria-labelledby={`${section.id}-title`}
					css={sectionCss}
				>
					<h2 id={`${section.id}-title`} css={{ margin: 0 }}>
						{section.title}
					</h2>
					{section.render()}
				</section>
			))}
		</main>
	)
}

function GalleryRow(props: { label: string; children: ReactNode }) {
	return (
		<div css={rowCss}>
			<span css={rowLabelCss}>{props.label}</span>
			<div css={rowItemsCss}>{props.children}</div>
		</div>
	)
}

const pageCss = {
	display: 'grid',
	gap: spacing.xl,
	maxWidth: '72rem',
	margin: '0 auto',
	padding: `${spacing.xl} 0`,
}

const tocCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.md,
	margin: 0,
	padding: 0,
	listStyle: 'none',
}

const sectionCss = {
	display: 'grid',
	gap: spacing.md,
	padding: spacing.lg,
	border: `1px solid ${colors.border}`,
	borderRadius: '16px',
	backgroundColor: colors.surface,
}

const rowCss = {
	display: 'grid',
	gridTemplateColumns: 'minmax(6rem, max-content) 1fr',
	alignItems: 'center',
	gap: spacing.md,
	'@media (max-width: 640px)': { gridTemplateColumns: '1fr' },
}

const rowLabelCss = {
	fontSize: '0.85rem',
	fontFamily: typography.fontFamilyMono,
	color: colors.textMuted,
}

const rowItemsCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	gap: spacing.sm,
}
