/** @jsxImportSource @emotion/react */
import { Field } from '../components/field.tsx'
import { Button } from '../components/button.tsx'
import { publicAsset } from '../public-assets.ts'
import {
	formatExtraAuthorizeParams,
	formatTokenExchangeStyle,
	joinList,
	type ActionState,
} from '#client/routes/admin-platform-integrations-shared.ts'
import type { AdminPlatformIntegrationApp } from '#universal/loader-data.ts'
import {
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getLogoWellCss,
	getFieldControlCss,
} from '#universal/styles/style-primitives.ts'
import { colors, mq, spacing } from '#universal/styles/tokens.ts'
import type { ChangeEvent, FormEvent } from 'react'
import { recordBodyCss } from './record-table.tsx'
import { Input, Select, Textarea } from '../components/input.tsx'
import { Checkbox } from '../components/choice-controls.tsx'
export function IntegrationForm(input: {
	editingApp: AdminPlatformIntegrationApp | null
	formRevision: number
	actionState: ActionState
	pendingSlug: string | null
	removeLogoChecked: boolean
	onSubmit: (event: FormEvent<HTMLFormElement>) => void
	onLogoFileChange: (event: ChangeEvent<HTMLInputElement>) => void
	onRemoveLogoChange: (checked: boolean) => void
	onToggleEnabled: (app: AdminPlatformIntegrationApp) => void
	onToggleVisibility: (app: AdminPlatformIntegrationApp) => void
	onDelete: (app: AdminPlatformIntegrationApp) => void
	onCancel: () => void
}) {
	const {
		editingApp,
		formRevision,
		actionState,
		pendingSlug,
		removeLogoChecked,
	} = input
	const isEditing = editingApp != null
	const formKey =
		isEditing && editingApp
			? `edit-${editingApp.slug}:${formRevision}`
			: `create:${formRevision}`
	return (
		<form
			key={formKey}
			method="post"
			noValidate
			onSubmit={input.onSubmit}
			css={recordBodyCss}
		>
			<div
				css={{
					display: 'flex',
					justifyContent: 'space-between',
					gap: spacing.md,
					flexWrap: 'wrap',
					alignItems: 'flex-start',
				}}
			>
				<div css={{ display: 'grid', gap: spacing.xs, minWidth: 0 }}>
					<h2 css={cardTitleCss}>
						{isEditing ? 'Edit integration' : 'Create integration'}
					</h2>
					<p css={descriptionCss}>
						Save creates or updates a platform OAuth app. Omitted write-only
						fields retain stored values.
					</p>
					{isEditing && editingApp ? (
						<p css={descriptionCss}>
							{editingApp.visibility === 'published'
								? editingApp.enabled
									? 'Published: offered on onboarding, account integrations, and the connect chooser.'
									: 'Published, but disabled: hidden and rejecting new connects until enabled.'
								: 'Draft: hidden from discovery. Existing connections keep working.'}
						</p>
					) : null}
				</div>
				{isEditing && editingApp ? (
					<div
						css={{
							display: 'flex',
							flexWrap: 'wrap',
							gap: spacing.sm,
						}}
					>
						<Button
							type="button"
							disabled={actionState !== 'idle'}
							onClick={() => input.onToggleEnabled(editingApp)}
							variant="secondary"
						>
							{actionState === 'toggling-enabled' &&
							pendingSlug === editingApp.slug
								? 'Saving…'
								: editingApp.enabled
									? 'Disable'
									: 'Enable'}
						</Button>
						<Button
							type="button"
							disabled={actionState !== 'idle'}
							data-testid="platform-integration-toggle-visibility"
							onClick={() => input.onToggleVisibility(editingApp)}
							variant="secondary"
						>
							{actionState === 'toggling-visibility' &&
							pendingSlug === editingApp.slug
								? 'Saving…'
								: editingApp.visibility === 'published'
									? 'Move to draft'
									: 'Publish'}
						</Button>
						<Button
							type="button"
							disabled={actionState !== 'idle'}
							onClick={() => input.onDelete(editingApp)}
							variant="danger"
						>
							{actionState === 'deleting' && pendingSlug === editingApp.slug
								? 'Deleting…'
								: 'Delete'}
						</Button>
					</div>
				) : null}
			</div>

			<div css={{ display: 'grid', gap: spacing.md }}>
				<div
					css={{
						display: 'grid',
						gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
						gap: spacing.md,
						[mq.mobile]: {
							gridTemplateColumns: 'minmax(0, 1fr)',
						},
					}}
				>
					<Field
						label={
							<>
								Slug
								{isEditing
									? ' (changing it renames in place — secret, logo, and connections carry over)'
									: ''}
							</>
						}
					>
						<Input
							name="slug"
							type="text"
							required
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.slug ?? ''}
						/>
					</Field>
					<Field label="Provider">
						<Input
							name="provider"
							type="text"
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.provider ?? ''}
						/>
					</Field>
					<Field label="Label">
						<Input
							name="label"
							type="text"
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.label ?? ''}
						/>
					</Field>
					<Field label="Description (shown to users before they connect)">
						<Textarea
							name="description"
							rows={3}
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.description ?? ''}
						/>
					</Field>
					<Field label="Client id">
						<Input
							name="clientId"
							type="text"
							required
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.clientId ?? ''}
						/>
					</Field>
					<Field label="Client secret">
						<Input
							name="clientSecret"
							type="password"
							autoComplete="new-password"
							placeholder="unchanged when empty"
							disabled={actionState !== 'idle'}
						/>
					</Field>
					<Field label="Flow">
						<Select
							name="flow"
							defaultValue={editingApp?.flow ?? 'pkce'}
							required
							disabled={actionState !== 'idle'}
						>
							<option value="pkce">pkce</option>
							<option value="confidential">confidential</option>
							<option value="device">device</option>
						</Select>
					</Field>
					<Field label="Token exchange style">
						<Select
							name="tokenExchangeStyle"
							defaultValue={formatTokenExchangeStyle(
								editingApp?.tokenExchangeStyle ?? null,
							)}
							disabled={actionState !== 'idle'}
						>
							{(['default', 'form', 'basic-json', 'basic-form'] as const).map(
								(style) => (
									<option key={style} value={style}>
										{style}
									</option>
								),
							)}
						</Select>
					</Field>
					<Field label="Scope separator">
						<Input
							name="scopeSeparator"
							type="text"
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.scopeSeparator ?? ''}
						/>
					</Field>
					<Field label="Token URL">
						<Input
							name="tokenUrl"
							type="url"
							required
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.tokenUrl ?? ''}
						/>
					</Field>
					<Field
						label={
							<>
								Authorize URL
								{(editingApp?.flow ?? 'pkce') === 'device'
									? ' (optional for device flow)'
									: ''}
							</>
						}
					>
						<Input
							name="authorizeUrl"
							type="url"
							required={(editingApp?.flow ?? 'pkce') !== 'device'}
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.authorizeUrl ?? ''}
						/>
					</Field>
					<Field label="Device authorization URL">
						<Input
							name="deviceAuthorizationUrl"
							type="url"
							required={(editingApp?.flow ?? 'pkce') === 'device'}
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.deviceAuthorizationUrl ?? ''}
							placeholder="Required when flow is device"
						/>
					</Field>
					<Field label="API base URL">
						<Input
							name="apiBaseUrl"
							type="url"
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.apiBaseUrl ?? ''}
						/>
					</Field>
				</div>
				<Field label="Allowed scopes">
					<Input
						name="allowedScopes"
						type="text"
						disabled={actionState !== 'idle'}
						placeholder="Comma or whitespace separated"
						defaultValue={joinList(editingApp?.allowedScopes ?? [])}
					/>
				</Field>
				<Field label="Default scopes">
					<Input
						name="defaultScopes"
						type="text"
						disabled={actionState !== 'idle'}
						placeholder="Comma or whitespace separated"
						defaultValue={joinList(editingApp?.defaultScopes ?? [])}
					/>
				</Field>
				<Field label="Required hosts">
					<Input
						name="requiredHosts"
						type="text"
						disabled={actionState !== 'idle'}
						placeholder="Comma or whitespace separated"
						defaultValue={joinList(editingApp?.requiredHosts ?? [])}
					/>
				</Field>
				<Field label="Extra authorize params">
					<Textarea
						name="extraAuthorizeParams"
						disabled={actionState !== 'idle'}
						placeholder="key=value (one per line)"
						defaultValue={formatExtraAuthorizeParams(
							editingApp?.extraAuthorizeParams ?? {},
						)}
					/>
				</Field>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Logo</span>
					<input
						data-field-ring
						name="logo"
						type="file"
						accept="image/svg+xml,image/png,image/jpeg,image/webp"
						disabled={actionState !== 'idle'}
						onChange={input.onLogoFileChange}
						css={getFieldControlCss()}
					/>
				</label>
				{isEditing && editingApp?.logoPath ? (
					<div
						css={{
							display: 'flex',
							alignItems: 'center',
							gap: spacing.md,
							flexWrap: 'wrap',
						}}
					>
						<span css={getLogoWellCss({ size: '2.5rem', radius: '10px' })}>
							<img
								src={publicAsset(editingApp.logoPath)}
								alt=""
								width={32}
								height={32}
								css={{
									display: 'block',
									width: '1.75rem',
									height: '1.75rem',
									objectFit: 'contain',
								}}
							/>
						</span>
						<label
							css={{
								...fieldCss,
								display: 'flex',
								flexDirection: 'row',
								alignItems: 'center',
								gap: spacing.sm,
							}}
						>
							<Checkbox
								name="removeLogo"
								checked={removeLogoChecked}
								disabled={actionState !== 'idle'}
								onChange={(event) => {
									const checkbox = event.currentTarget
									if (!(checkbox instanceof HTMLInputElement)) return
									input.onRemoveLogoChange(checkbox.checked)
								}}
								css={{
									width: '1.25rem',
									height: '1.25rem',
									accentColor: colors.primary,
								}}
							/>
							<span css={fieldLabelCss}>Remove logo</span>
						</label>
					</div>
				) : null}
				<label
					css={{
						...fieldCss,
						display: 'flex',
						flexDirection: 'row',
						alignItems: 'center',
						gap: spacing.sm,
					}}
				>
					<Checkbox
						name="enabled"
						defaultChecked={editingApp?.enabled ?? true}
						disabled={actionState !== 'idle'}
						css={{
							width: '1.25rem',
							height: '1.25rem',
							accentColor: colors.primary,
						}}
					/>
					<span css={fieldLabelCss}>Enabled</span>
				</label>
				<div
					css={{
						display: 'flex',
						flexWrap: 'wrap',
						gap: spacing.sm,
						alignItems: 'center',
					}}
				>
					<Button
						type="submit"
						disabled={actionState !== 'idle'}
						variant="primary"
					>
						{actionState === 'saving-form'
							? 'Saving…'
							: isEditing
								? 'Save changes'
								: 'Create integration'}
					</Button>
					{isEditing ? (
						<Button
							type="button"
							disabled={actionState !== 'idle'}
							onClick={input.onCancel}
							variant="secondary"
						>
							Cancel edit
						</Button>
					) : (
						<Button
							type="button"
							disabled={actionState !== 'idle'}
							onClick={input.onCancel}
							variant="secondary"
						>
							Cancel
						</Button>
					)}
				</div>
			</div>
		</form>
	)
}
