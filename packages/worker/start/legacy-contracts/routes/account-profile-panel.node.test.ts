import { jsx } from 'react/jsx-runtime'
import { renderStartPage as renderToString } from '../../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { AccountProfilePanel } from '../../pages/account-profile-panel.tsx'

function panelProps(
	overrides: Partial<Parameters<typeof AccountProfilePanel>[0]> = {},
) {
	return {
		email: 'jaimie@example.com',
		emailVerified: true,
		username: 'jklotz08',
		draftDisplayName: 'Jaimie',
		draftBio: '',
		draftProfileVisibility: 'public' as const,
		draftEmail: 'jaimie@example.com',
		emailChangePassword: '',
		avatarUrl: null,
		avatarStatus: 'idle' as const,
		isSaving: false,
		isSendingEmailChange: false,
		profileUnchanged: false,
		normalizedDraftEmail: 'jaimie@example.com',
		emailChangeMessage: null,
		emailChangeTone: 'info' as const,
		emailChangeOpen: false,
		onProfileSubmit: () => undefined,
		onEmailChangeSubmit: () => undefined,
		onAvatarSelected: () => undefined,
		onRemoveAvatar: () => undefined,
		onDraftDisplayNameChange: () => undefined,
		onDraftBioChange: () => undefined,
		onDraftProfileVisibilityChange: () => undefined,
		onDraftEmailInput: () => undefined,
		onEmailChangeToggle: () => undefined,
		onEmailChangePasswordInput: () => undefined,
		...overrides,
	}
}

test('profile panel shows the permanent username as a URL with help text, not an input', async () => {
	const html = await renderToString(jsx(AccountProfilePanel, panelProps()))

	expect(html).not.toMatch(/<input[^>]*name="username"/)
	expect(html).toContain('kody.codes/@jklotz08')
	expect(html).toMatch(
		/id="account-username"[^>]*aria-describedby="account-username-note"/,
	)
	expect(html).toContain('Handles are permanent and cannot be changed later.')
})
