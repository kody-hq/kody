import { expect, test } from 'vitest'
import { routes } from './routes.ts'

test('URL builders encode identifiers separately from file paths and suffixes', () => {
	expect(routes.profile.href({ username: 'a/b.c' })).toBe('/@a%2Fb%2Ec')
	expect(routes.docDetailMarkdown.href({ slug: 'intro.part' })).toBe(
		'/docs/intro%2Epart.md',
	)
	expect(
		routes.profileAvatar.href({ username: 'ada', hash: 'a.b', ext: 'png' }),
	).toBe('/profiles/ada/avatar/a%2Eb.png')
	expect(
		routes.communityPackageRaw.href({
			username: 'ada',
			kodyId: 'pkg',
			ref: 'feature/x',
			relativePath: 'docs/hello world.md',
		}),
	).toBe('/@ada/pkg/raw/feature%2Fx/docs/hello%20world.md')
	expect(
		routes.communityPackageRaw.href({
			username: 'ada',
			kodyId: 'pkg',
			ref: 'main',
		}),
	).toBe('/@ada/pkg/raw/main')
	expect(() =>
		routes.communityPackageRaw.href({
			username: 'ada',
			kodyId: 'pkg',
			ref: 'main',
			relativePath: '../private',
		}),
	).toThrow('dot segments')
})

test('URL search builders preserve duplicate filters and encode redirects', () => {
	expect(
		routes.community.href(null, {
			searchParams: new URLSearchParams([
				['tag', 'a'],
				['tag', 'b'],
			]),
		}),
	).toBe('/community?tag=a&tag=b')
	expect(
		routes.login.href(null, {
			searchParams: { redirectTo: '/@ada/pkg?tab=files' },
		}),
	).toBe('/login?redirectTo=%2F%40ada%2Fpkg%3Ftab%3Dfiles')
	expect(
		routes.community.href(null, { searchParams: new URLSearchParams() }),
	).toBe('/community')
})

test('an explicit empty file path preserves the root trailing slash', () => {
	expect(
		routes.communityPackageRaw.href({
			username: 'ada',
			kodyId: 'pkg',
			ref: 'main',
			relativePath: '',
		}),
	).toBe('/@ada/pkg/raw/main/')
	expect(
		routes.communityPackageRaw.href({
			username: 'ada',
			kodyId: 'pkg',
			ref: 'main',
			relativePath: null,
		}),
	).toBe('/@ada/pkg/raw/main')
})
