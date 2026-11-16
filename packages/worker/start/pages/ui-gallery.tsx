/** @jsxImportSource @emotion/react */
import { useState, type ReactNode } from 'react'
import { Button } from '../components/button.tsx'
import { Checkbox, Radio, Switch } from '../components/choice-controls.tsx'
import { Field } from '../components/field.tsx'
import { Input, Select, Textarea } from '../components/input.tsx'
import { renderIcon } from '../components/icon.tsx'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	visuallyHiddenCss,
	type ButtonSize,
	type ButtonVariant,
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
	{
		id: 'field',
		title: 'Field, Input, Textarea, Select',
		render: () => (
			<div css={fieldGridCss}>
				<Field label="Default">
					<Input name="gallery-default" placeholder="Placeholder" />
				</Field>
				<Field
					label="With description"
					description="Help text, announced with the control."
				>
					<Input name="gallery-description" defaultValue="Some value" />
				</Field>
				<Field label="Invalid" error="Enter a valid email address.">
					<Input
						name="gallery-error"
						type="email"
						defaultValue="not an email"
					/>
				</Field>
				<Field label="Disabled">
					<Input name="gallery-disabled" defaultValue="Read only" disabled />
				</Field>
				<Field label="Small">
					<Input name="gallery-small" size="sm" placeholder="size=sm" />
				</Field>
				<Field label="Canvas background">
					<Input
						name="gallery-canvas"
						background="canvas"
						placeholder="background=canvas"
					/>
				</Field>
				<Field label="Textarea" description="Grows with rows.">
					<Textarea
						name="gallery-textarea"
						rows={3}
						defaultValue="Multi-line text"
					/>
				</Field>
				<Field label="Select">
					<Select name="gallery-select" defaultValue="team">
						<option value="free">Free</option>
						<option value="team">Team</option>
					</Select>
				</Field>
			</div>
		),
	},
	{
		id: 'choice',
		title: 'Checkbox, Radio, Switch',
		render: () => <ChoiceControlsDemo />,
	},
]

function ChoiceControlsDemo() {
	const [items, setItems] = useState([true, false])
	const [enabled, setEnabled] = useState(true)
	const all = items.every(Boolean)
		? true
		: items.some(Boolean)
			? 'mixed'
			: false
	return (
		<>
			<GalleryRow label="checkbox">
				<label css={choiceLabelCss}>
					<Checkbox
						checked={all}
						onChange={() => setItems(items.map(() => all !== true))}
					/>
					Select all
				</label>
				{items.map((checked, index) => (
					<label key={index} css={choiceLabelCss}>
						<Checkbox
							checked={checked}
							onChange={(event) =>
								setItems(
									items.map((value, i) =>
										i === index ? event.target.checked : value,
									),
								)
							}
						/>
						{`Item ${index + 1}`}
					</label>
				))}
				<label css={choiceLabelCss}>
					<Checkbox disabled />
					Disabled
				</label>
			</GalleryRow>
			<GalleryRow label="radio">
				<fieldset css={fieldsetCss}>
					<legend css={visuallyHiddenCss}>Plan</legend>
					{['Free', 'Team', 'Enterprise'].map((plan) => (
						<label key={plan} css={choiceLabelCss}>
							<Radio
								name="gallery-plan"
								value={plan}
								defaultChecked={plan === 'Team'}
								disabled={plan === 'Enterprise'}
							/>
							{plan}
						</label>
					))}
				</fieldset>
			</GalleryRow>
			<GalleryRow label="switch">
				<label css={choiceLabelCss}>
					<Switch checked={enabled} onCheckedChange={setEnabled} />
					Email notifications
				</label>
				<Switch
					aria-label="Disabled off"
					checked={false}
					onCheckedChange={() => {}}
					disabled
				/>
				<Switch
					aria-label="Disabled on"
					checked
					onCheckedChange={() => {}}
					disabled
				/>
			</GalleryRow>
		</>
	)
}

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

const fieldGridCss = {
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fill, minmax(16rem, 1fr))',
	gap: spacing.lg,
}

const choiceLabelCss = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: spacing.sm,
}

const fieldsetCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	gap: spacing.md,
	margin: 0,
	padding: 0,
	border: 'none',
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
