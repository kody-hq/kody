/** @jsxImportSource @emotion/react */
import { type FormEvent } from 'react'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { type AccountSecretDetail } from '#universal/loader-data.ts'
import { Combobox, type ComboboxOption } from '../components/combobox.tsx'
import {
	colors,
	mq,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	fieldCss,
	fieldLabelCss,
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
	getSelectCss,
} from '#universal/styles/style-primitives.ts'
import { SecretEditorFields } from './secret-editor-fields.tsx'
import {
	MetadataGrid,
	TimestampValue,
	accountInputCss,
} from './account-management-components.tsx'
import { recordBodyCss } from './record-table.tsx'
import { secretPackageIdentityCss } from './account-secrets-approval.tsx'
import {
	type EditorState,
	type SecretScope,
	formatRelativeTtl,
} from './account-secrets-shared.ts'

const selectCss = getSelectCss()

export type SecretEditorProps = {
	isCreating: boolean
	selectedSecret: AccountSecretDetail | null
	editorState: EditorState
	setEditorState: (next: EditorState) => void
	packageOptions: Array<{ id: string }>
	packageSelectOptions: Array<ComboboxOption>
	availableAllowedPackageOptions: Array<ComboboxOption>
	packagesById: ReadonlyMap<string, { kodyId: string; name: string }>
	canCreatePackageSecrets: boolean
	isMutating: boolean
	saveState: 'idle' | 'saving' | 'deleting'
	showSecretValue: boolean
	onToggleShowSecretValue: () => void
	secretValueAutofocusKey: string
	deleteArmed: boolean
	onDeleteArm: () => void
	onDeleteReset: () => void
	onSave: (event: FormEvent<HTMLFormElement>) => void
	onDelete: () => void
	updateAllowedHost: (index: number, value: string) => void
	addAllowedHost: () => void
	removeAllowedHost: (index: number) => void
	addAllowedPackage: (packageId: string) => void
	removeAllowedPackage: (packageId: string) => void
}

export function SecretEditor(props: SecretEditorProps) {
	const {
		isCreating,
		selectedSecret,
		editorState,
		setEditorState,
		packageOptions,
		packageSelectOptions,
		availableAllowedPackageOptions,
		packagesById,
		canCreatePackageSecrets,
		isMutating,
		saveState,
		showSecretValue,
		onToggleShowSecretValue,
		secretValueAutofocusKey,
		deleteArmed,
		onDeleteArm,
		onDeleteReset,
		onSave,
		onDelete,
		updateAllowedHost,
		addAllowedHost,
		removeAllowedHost,
		addAllowedPackage,
		removeAllowedPackage,
	} = props
	return (
		<form
			method="post"
			{...passwordManagerIgnoreProps}
			onSubmit={onSave}
			css={recordBodyCss}
		>
			<div css={{ display: 'grid', gap: spacing.xs }}>
				<h2
					css={{
						margin: 0,
						fontSize: typography.fontSize.lg,
						fontWeight: typography.fontWeight.semibold,
						color: colors.text,
					}}
				>
					{isCreating ? 'New secret' : selectedSecret?.name}
				</h2>
				<p css={{ margin: 0, color: colors.textMuted }}>
					{isCreating
						? 'Create a new user or package secret.'
						: 'Update the secret value and metadata for this entry.'}
				</p>
			</div>

			<div
				css={{
					display: 'grid',
					gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
					gap: spacing.md,
					[mq.mobile]: {
						gridTemplateColumns: '1fr',
					},
				}}
			>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Name</span>
					<input
						data-field-ring
						type="text"
						required
						value={editorState.name}
						placeholder="api-token"
						onInput={(event) => {
							setEditorState({
								...editorState,
								name: event.currentTarget.value,
							})
						}}
						css={accountInputCss}
					/>
				</label>

				<label css={fieldCss}>
					<span css={fieldLabelCss}>Scope</span>
					<select
						data-field-ring
						value={editorState.scope}
						onChange={(event) => {
							const scope = event.currentTarget.value as SecretScope
							setEditorState({
								...editorState,
								scope,
								packageId:
									scope === 'package'
										? editorState.packageId || packageOptions[0]?.id || ''
										: '',
							})
						}}
						css={selectCss}
					>
						<option value="user">User</option>
						{canCreatePackageSecrets ? (
							<option value="package">Package</option>
						) : null}
					</select>
				</label>
			</div>

			{editorState.scope === 'package' ? (
				<Combobox
					key={`secret-editor-package:${editorState.packageId}`}
					id="secret-editor-package"
					label="Package"
					placeholder="Choose a package"
					value={editorState.packageId}
					options={packageSelectOptions}
					onChange={(packageId) => {
						setEditorState({
							...editorState,
							packageId,
						})
					}}
				/>
			) : null}

			<SecretEditorFields
				autoFocusKey={secretValueAutofocusKey}
				description={editorState.description}
				onDescriptionChange={(description) => {
					setEditorState({
						...editorState,
						description,
					})
				}}
				expiresAt={editorState.expiresAt}
				onExpiresAtChange={(expiresAt) => {
					setEditorState({
						...editorState,
						expiresAt,
					})
				}}
				value={editorState.value}
				onValueChange={(value) => {
					setEditorState({
						...editorState,
						value,
					})
				}}
				showSecretValue={showSecretValue}
				onToggleShowSecretValue={onToggleShowSecretValue}
				allowedHosts={editorState.allowedHosts}
				onUpdateAllowedHost={updateAllowedHost}
				onAddAllowedHost={addAllowedHost}
				onRemoveAllowedHost={removeAllowedHost}
				fillPlacement={editorState.fillPlacement}
				onFillPlacementChange={(fillPlacement) => {
					setEditorState({
						...editorState,
						fillPlacement,
					})
				}}
				allowedHostsListName="allowed-hosts"
			/>

			{editorState.scope === 'user' ? (
				<div css={{ display: 'grid', gap: spacing.sm }}>
					<div css={{ display: 'grid', gap: spacing.xs }}>
						<span css={fieldLabelCss}>Allowed packages</span>
						<p css={{ margin: 0, color: colors.textMuted }}>
							Self-authored and adopted packages can already read and use this
							secret. Add a package here to grant an unadopted community fork,
							or to let any package update or delete this secret. Sending the
							secret to a site still needs a host under Advanced details — that
							is never automatic, including for packages you wrote.
						</p>
					</div>
					{editorState.allowedPackages.length > 0 ? (
						<div css={{ display: 'grid', gap: spacing.sm }}>
							{editorState.allowedPackages.map((packageId) => {
								const metadata = packagesById.get(packageId)
								const packageLabel = metadata?.kodyId ?? 'Unknown package'
								return (
									<div
										key={packageId}
										css={{
											display: 'grid',
											gridTemplateColumns: 'minmax(0, 1fr) auto',
											gap: spacing.sm,
											alignItems: 'center',
											padding: spacing.sm,
											border: `1px solid ${colors.border}`,
											borderRadius: radius.md,
										}}
									>
										<span css={secretPackageIdentityCss}>
											<strong>{packageLabel}</strong>
											<code>{packageId}</code>
										</span>
										<button
											type="button"
											aria-label={`Remove package ${packageLabel}`}
											onClick={() => removeAllowedPackage(packageId)}
											css={secondaryButtonCss}
										>
											Remove
										</button>
									</div>
								)
							})}
						</div>
					) : (
						<p css={{ margin: 0, color: colors.textMuted }}>
							No extra package grants. Self-authored and adopted packages can
							still read and use this secret.
						</p>
					)}
					{availableAllowedPackageOptions.length > 0 ? (
						<Combobox
							key={`allowed-package-picker:${editorState.allowedPackages.join(',')}`}
							id="secret-allowed-package"
							label="Add allowed package"
							placeholder="Search saved packages"
							value=""
							options={availableAllowedPackageOptions}
							onChange={addAllowedPackage}
						/>
					) : packageOptions.length > 0 ? (
						<p css={{ margin: 0, color: colors.textMuted }}>
							All saved packages are already allowed.
						</p>
					) : null}
				</div>
			) : null}

			{selectedSecret ? (
				<MetadataGrid
					items={[
						{
							label: 'Created',
							value: <TimestampValue value={selectedSecret.createdAt} />,
						},
						{
							label: 'Updated',
							value: <TimestampValue value={selectedSecret.updatedAt} />,
						},
						{
							label: 'Expiry',
							value: formatRelativeTtl(selectedSecret.ttlMs),
						},
					]}
				/>
			) : null}

			<div
				css={{
					display: 'flex',
					gap: spacing.sm,
					flexWrap: 'wrap',
				}}
			>
				<button
					type="submit"
					disabled={
						isMutating ||
						(editorState.scope === 'package' && !editorState.packageId)
					}
					css={primaryButtonCss}
				>
					{saveState === 'saving' ? 'Saving...' : 'Save'}
				</button>
				{editorState.currentId ? (
					<button
						type="button"
						disabled={isMutating}
						aria-label={
							deleteArmed
								? `Confirm delete secret "${editorState.name}"`
								: `Delete secret "${editorState.name}"`
						}
						title={
							deleteArmed
								? `Click again to delete "${editorState.name}"`
								: `Delete secret "${editorState.name}"`
						}
						css={dangerButtonCss}
						onBlur={onDeleteReset}
						onClick={() => {
							if (deleteArmed) {
								onDeleteReset()
								onDelete()
							} else onDeleteArm()
						}}
					>
						{saveState === 'deleting'
							? 'Deleting...'
							: deleteArmed
								? 'Confirm delete'
								: 'Delete'}
					</button>
				) : null}
			</div>
		</form>
	)
}

const primaryButtonCss = getPillButtonCss({ size: 'sm' })
const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
const dangerButtonCss = getDangerPillCss({ size: 'sm' })
