import { jsx } from 'react/jsx-runtime'
import { renderStartPage as renderToString } from '../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { UserAvatar } from '../components/user-avatar.tsx'

test('user avatar owns responsive face size in its own css layer', async () => {
	const fixedHtml = await renderToString(
		jsx(UserAvatar, { displayName: 'Jane', avatarUrl: null, size: 32 }),
	)
	expect(fixedHtml).toContain('width:32px')
	expect(fixedHtml).toContain('height:32px')
	expect(fixedHtml).not.toContain('@media (min-width: 821px)')

	const profileHtml = await renderToString(
		jsx(UserAvatar, {
			displayName: 'Jane',
			avatarUrl: '/profiles/jane/avatar.png',
			size: { narrow: 72, wide: 160 },
			variant: 'well',
			testId: 'profile-avatar',
		}),
	)
	expect(profileHtml).toContain('data-testid="profile-avatar"')
	expect(profileHtml).toContain('width="160"')
	expect(profileHtml).toContain('height="160"')
	expect(profileHtml).toContain('width:72px')
	expect(profileHtml).toContain('height:72px')
	expect(profileHtml).toContain('@media (min-width: 821px)')
	expect(profileHtml).toContain('width:160px')
	expect(profileHtml).toContain('height:160px')
})
