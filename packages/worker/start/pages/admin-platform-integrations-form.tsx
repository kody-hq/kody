/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
import {
	formatExtraAuthorizeParams,
	formatTokenExchangeStyle,
	joinList,
	type ActionState,
} from '#client/routes/admin-platform-integrations-shared.ts'
import { type AdminPlatformIntegrationApp } from '#universal/loader-data.ts'
import {
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getDangerPillCss,
	getGhostButtonCss,
	getLogoWellCss,
	getPillButtonCss,
	getSelectCss,
} from '#universal/styles/style-primitives.ts'
import { colors, mq, spacing } from '#universal/styles/tokens.ts'
import { type ChangeEvent, type FormEvent } from 'react'
import {
	accountInputCss,
	accountTextareaCss,
} from './account-management-components.tsx'
import { recordBodyCss } from './record-table.tsx'
const selectCss = getSelectCss()
const primaryButtonCss = getPillButtonCss({ size: 'sm' })
const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
const dangerButtonCss = getDangerPillCss({ size: 'sm' })
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
						<button
							type="button"
							disabled={actionState !== 'idle'}
							onClick={() => input.onToggleEnabled(editingApp)}
							css={secondaryButtonCss}
						>
							{actionState === 'toggling-enabled' &&
							pendingSlug === editingApp.slug
								? 'Saving…'
								: editingApp.enabled
									? 'Disable'
									: 'Enable'}
						</button>
						<button
							type="button"
							disabled={actionState !== 'idle'}
							data-testid="platform-integration-toggle-visibility"
							onClick={() => input.onToggleVisibility(editingApp)}
							css={secondaryButtonCss}
						>
							{actionState === 'toggling-visibility' &&
							pendingSlug === editingApp.slug
								? 'Saving…'
								: editingApp.visibility === 'published'
									? 'Move to draft'
									: 'Publish'}
						</button>
						<button
							type="button"
							disabled={actionState !== 'idle'}
							onClick={() => input.onDelete(editingApp)}
							css={dangerButtonCss}
						>
							{actionState === 'deleting' && pendingSlug === editingApp.slug
								? 'Deleting…'
								: 'Delete'}
						</button>
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
					<label css={fieldCss}>
						<span css={fieldLabelCss}>
							Slug
							{isEditing
								? ' (changing it renames in place — secret, logo, and connections carry over)'
								: ''}
						</span>
						<input
							data-field-ring
							name="slug"
							type="text"
							required
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.slug ?? ''}
							css={accountInputCss}
						/>
					</label>
					<label css={fieldCss}>
						<span css={fieldLabelCss}>Provider</span>
						<input
							data-field-ring
							name="provider"
							type="text"
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.provider ?? ''}
							css={accountInputCss}
						/>
					</label>
					<label css={fieldCss}>
						<span css={fieldLabelCss}>Label</span>
						<input
							data-field-ring
							name="label"
							type="text"
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.label ?? ''}
							css={accountInputCss}
						/>
					</label>
					<label css={fieldCss}>
						<span css={fieldLabelCss}>
							Description (shown to users before they connect)
						</span>
						<textarea
							data-field-ring
							name="description"
							rows={3}
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.description ?? ''}
							css={accountInputCss}
						/>
					</label>
					<label css={fieldCss}>
						<span css={fieldLabelCss}>Client id</span>
						<input
							data-field-ring
							name="clientId"
							type="text"
							required
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.clientId ?? ''}
							css={accountInputCss}
						/>
					</label>
					<label css={fieldCss}>
						<span css={fieldLabelCss}>Client secret</span>
						<input
							data-field-ring
							name="clientSecret"
							type="password"
							autoComplete="new-password"
							placeholder="unchanged when empty"
							disabled={actionState !== 'idle'}
							css={accountInputCss}
						/>
					</label>
					<label css={fieldCss}>
						<span css={fieldLabelCss}>Flow</span>
						<select
							data-field-ring
							name="flow"
							defaultValue={editingApp?.flow ?? 'pkce'}
							required
							disabled={actionState !== 'idle'}
							css={selectCss}
						>
							<option value="pkce">pkce</option>
							<option value="confidential">confidential</option>
							<option value="device">device</option>
						</select>
					</label>
					<label css={fieldCss}>
						<span css={fieldLabelCss}>Token exchange style</span>
						<select
							data-field-ring
							name="tokenExchangeStyle"
							defaultValue={formatTokenExchangeStyle(
								editingApp?.tokenExchangeStyle ?? null,
							)}
							disabled={actionState !== 'idle'}
							css={selectCss}
						>
							{(['default', 'form', 'basic-json', 'basic-form'] as const).map(
								(style) => (
									<option key={style} value={style}>
										{style}
									</option>
								),
							)}
						</select>
					</label>
					<label css={fieldCss}>
						<span css={fieldLabelCss}>Scope separator</span>
						<input
							data-field-ring
							name="scopeSeparator"
							type="text"
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.scopeSeparator ?? ''}
							css={accountInputCss}
						/>
					</label>
					<label css={fieldCss}>
						<span css={fieldLabelCss}>Token URL</span>
						<input
							data-field-ring
							name="tokenUrl"
							type="url"
							required
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.tokenUrl ?? ''}
							css={accountInputCss}
						/>
					</label>
					<label css={fieldCss}>
						<span css={fieldLabelCss}>
							Authorize URL
							{(editingApp?.flow ?? 'pkce') === 'device'
								? ' (optional for device flow)'
								: ''}
						</span>
						<input
							data-field-ring
							name="authorizeUrl"
							type="url"
							required={(editingApp?.flow ?? 'pkce') !== 'device'}
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.authorizeUrl ?? ''}
							css={accountInputCss}
						/>
					</label>
					<label css={fieldCss}>
						<span css={fieldLabelCss}>Device authorization URL</span>
						<input
							data-field-ring
							name="deviceAuthorizationUrl"
							type="url"
							required={(editingApp?.flow ?? 'pkce') === 'device'}
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.deviceAuthorizationUrl ?? ''}
							placeholder="Required when flow is device"
							css={accountInputCss}
						/>
					</label>
					<label css={fieldCss}>
						<span css={fieldLabelCss}>API base URL</span>
						<input
							data-field-ring
							name="apiBaseUrl"
							type="url"
							disabled={actionState !== 'idle'}
							defaultValue={editingApp?.apiBaseUrl ?? ''}
							css={accountInputCss}
						/>
					</label>
				</div>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Allowed scopes</span>
					<input
						data-field-ring
						name="allowedScopes"
						type="text"
						disabled={actionState !== 'idle'}
						placeholder="Comma or whitespace separated"
						defaultValue={joinList(editingApp?.allowedScopes ?? [])}
						css={accountInputCss}
					/>
				</label>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Default scopes</span>
					<input
						data-field-ring
						name="defaultScopes"
						type="text"
						disabled={actionState !== 'idle'}
						placeholder="Comma or whitespace separated"
						defaultValue={joinList(editingApp?.defaultScopes ?? [])}
						css={accountInputCss}
					/>
				</label>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Required hosts</span>
					<input
						data-field-ring
						name="requiredHosts"
						type="text"
						disabled={actionState !== 'idle'}
						placeholder="Comma or whitespace separated"
						defaultValue={joinList(editingApp?.requiredHosts ?? [])}
						css={accountInputCss}
					/>
				</label>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Extra authorize params</span>
					<textarea
						data-field-ring
						name="extraAuthorizeParams"
						disabled={actionState !== 'idle'}
						placeholder="key=value (one per line)"
						defaultValue={formatExtraAuthorizeParams(
							editingApp?.extraAuthorizeParams ?? {},
						)}
						css={accountTextareaCss}
					/>
				</label>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Logo</span>
					<input
						data-field-ring
						name="logo"
						type="file"
						accept="image/svg+xml,image/png,image/jpeg,image/webp"
						disabled={actionState !== 'idle'}
						onChange={input.onLogoFileChange}
						css={accountInputCss}
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
							<input
								name="removeLogo"
								type="checkbox"
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
					<input
						name="enabled"
						type="checkbox"
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
					<button
						type="submit"
						disabled={actionState !== 'idle'}
						css={primaryButtonCss}
					>
						{actionState === 'saving-form'
							? 'Saving…'
							: isEditing
								? 'Save changes'
								: 'Create integration'}
					</button>
					{isEditing ? (
						<button
							type="button"
							disabled={actionState !== 'idle'}
							onClick={input.onCancel}
							css={secondaryButtonCss}
						>
							Cancel edit
						</button>
					) : (
						<button
							type="button"
							disabled={actionState !== 'idle'}
							onClick={input.onCancel}
							css={secondaryButtonCss}
						>
							Cancel
						</button>
					)}
				</div>
			</div>
		</form>
	)
}
