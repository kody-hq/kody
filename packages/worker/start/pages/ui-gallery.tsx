/** @jsxImportSource @emotion/react */
import { useState, type ReactNode } from 'react'
import { Button } from '../components/button.tsx'
import { Checkbox, Radio, Switch } from '../components/choice-controls.tsx'
import {
	Dialog,
	DialogActions,
	type DialogProps,
} from '../components/dialog.tsx'
import { Field } from '../components/field.tsx'
import { Input, Select, Textarea } from '../components/input.tsx'
import { renderIcon } from '../components/icon.tsx'
import {
	Menu,
	MenuCheckboxItem,
	MenuContent,
	MenuGroup,
	MenuItem,
	MenuLinkItem,
	MenuSeparator,
	MenuTrigger,
} from '../components/menu.tsx'
import { Tab, TabList, TabPanel, Tabs } from '../components/tabs.tsx'
import { Tooltip } from '../components/tooltip.tsx'
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
	{
		id: 'dialog',
		title: 'Dialog',
		render: () => (
			<GalleryRow label="open">
				<DialogDemo
					trigger="Rename file"
					title="Rename file"
					description="Names must be unique in this folder."
				>
					<Field label="Name">
						<Input name="gallery-dialog-name" defaultValue="notes.md" />
					</Field>
				</DialogDemo>
				<DialogDemo
					trigger="Quick look"
					aria-label="Quick look"
					dismissOnOutsideClick
				>
					<p css={{ margin: 0 }}>Click outside or press Escape to close.</p>
				</DialogDemo>
				<DialogDemo
					trigger="Delete file"
					role="alertdialog"
					title="Delete notes.md?"
					description="This can't be undone."
					confirm="Delete"
				/>
				<DialogDemo
					trigger="Side panel"
					placement="side"
					size="md"
					title="Details"
				>
					<p css={{ margin: 0 }}>Slides in from the inline end.</p>
				</DialogDemo>
			</GalleryRow>
		),
	},
	{
		id: 'menu',
		title: 'Menu',
		render: () => (
			<GalleryRow label="actions">
				<MenuDemo />
			</GalleryRow>
		),
	},
	{
		id: 'tooltip',
		title: 'Tooltip',
		render: () => (
			<GalleryRow label="hover or focus">
				<Button
					type="button"
					variant="secondary"
					aria-describedby="gallery-tooltip-top"
				>
					Above
					<Tooltip id="gallery-tooltip-top">Shows on hover and focus.</Tooltip>
				</Button>
				<Button
					type="button"
					variant="ghost"
					iconOnly
					aria-label="Help"
					aria-describedby="gallery-tooltip-bottom"
				>
					{renderIcon('information')}
					<Tooltip id="gallery-tooltip-bottom" side="bottom" align="start">
						Escape hides it until focus leaves.
					</Tooltip>
				</Button>
			</GalleryRow>
		),
	},
	{
		id: 'tabs',
		title: 'Tabs',
		render: () => (
			<>
				<GalleryRow label="segmented">
					<Tabs defaultActiveTab="html">
						<TabList aria-label="Email body">
							<Tab name="html">HTML</Tab>
							<Tab name="text">Text</Tab>
							<Tab name="source" disabled>
								Source
							</Tab>
						</TabList>
						<TabPanel name="html">Rendered HTML body.</TabPanel>
						<TabPanel name="text">Plain text body.</TabPanel>
						<TabPanel name="source">Raw source.</TabPanel>
					</Tabs>
				</GalleryRow>
				<GalleryRow label="underline">
					<Tabs variant="underline" defaultActiveTab="sharing">
						<TabList aria-label="File settings">
							<Tab name="sharing">Sharing</Tab>
							<Tab name="details">Details</Tab>
						</TabList>
						<TabPanel name="sharing" css={{ paddingBlock: spacing.sm }}>
							People and teams with access.
						</TabPanel>
						<TabPanel name="details" css={{ paddingBlock: spacing.sm }}>
							Type, modified date, and location.
						</TabPanel>
					</Tabs>
				</GalleryRow>
			</>
		),
	},
]

function MenuDemo() {
	const [wrap, setWrap] = useState(true)
	const [last, setLast] = useState('Nothing chosen yet.')
	return (
		<>
			<Menu>
				<MenuTrigger render={<Button type="button" variant="secondary" />}>
					File actions
				</MenuTrigger>
				<MenuContent aria-label="File actions">
					<MenuGroup label="Edit">
						<MenuItem onClick={() => setLast('Renamed.')}>Rename</MenuItem>
						<MenuItem onClick={() => setLast('Duplicated.')}>
							Duplicate
						</MenuItem>
						<MenuItem disabled>Move (no other folders)</MenuItem>
					</MenuGroup>
					<MenuSeparator />
					<MenuCheckboxItem checked={wrap} onCheckedChange={setWrap}>
						Wrap lines
					</MenuCheckboxItem>
					<MenuLinkItem href="/docs">Open docs</MenuLinkItem>
					<MenuSeparator />
					<MenuItem tone="danger" onClick={() => setLast('Deleted.')}>
						Delete
					</MenuItem>
				</MenuContent>
			</Menu>
			<span role="status" css={{ color: colors.textMuted }}>
				{last}
			</span>
		</>
	)
}

type DialogDemoProps = Omit<DialogProps, 'open' | 'onClose' | 'children'> & {
	trigger: string
	confirm?: string
	children?: ReactNode
}

function DialogDemo({ trigger, confirm, children, ...props }: DialogDemoProps) {
	const [open, setOpen] = useState(false)
	const close = () => setOpen(false)
	return (
		<>
			<Button type="button" variant="secondary" onClick={() => setOpen(true)}>
				{trigger}
			</Button>
			<Dialog {...(props as DialogProps)} open={open} onClose={close}>
				{children}
				<DialogActions>
					<Button type="button" variant="secondary" onClick={close}>
						Cancel
					</Button>
					<Button
						type="button"
						variant={props.role === 'alertdialog' ? 'danger' : 'primary'}
						onClick={close}
					>
						{confirm ?? 'Save'}
					</Button>
				</DialogActions>
			</Dialog>
		</>
	)
}

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
