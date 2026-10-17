import { expect, test } from 'vitest'
import { renderStartPage as renderToString } from './test-support/render-start-page.ts'
import {
	listPackageStatusSignifiers,
	renderPackageStatusSignifiers,
} from './components/package-status-signifiers.tsx'

test('private packages get Package + lock and never a not-published mark', () => {
	expect(
		listPackageStatusSignifiers({ isPrivate: true, isListed: false }),
	).toEqual([
		{ kind: 'package', name: 'box', title: 'Package' },
		{ kind: 'private', name: 'lock', title: 'Private' },
	])
	expect(
		listPackageStatusSignifiers({ isPrivate: true, isListed: true }),
	).toEqual([
		{ kind: 'package', name: 'box', title: 'Package' },
		{ kind: 'private', name: 'lock', title: 'Private' },
	])
})

test('unlisted public packages get Package + not-published; listed get Package only', () => {
	expect(
		listPackageStatusSignifiers({ isPrivate: false, isListed: false }),
	).toEqual([
		{ kind: 'package', name: 'box', title: 'Package' },
		{ kind: 'unpublished', name: 'file', title: 'Not published' },
	])
	expect(
		listPackageStatusSignifiers({ isPrivate: false, isListed: true }),
	).toEqual([{ kind: 'package', name: 'box', title: 'Package' }])
})

test('plain repos get Repo mark; private lock only; never not-published', () => {
	expect(
		listPackageStatusSignifiers({
			isPrivate: false,
			isListed: false,
			hasPackage: false,
		}),
	).toEqual([{ kind: 'repo', name: 'folder', title: 'Repo' }])
	expect(
		listPackageStatusSignifiers({
			isPrivate: true,
			isListed: false,
			hasPackage: false,
		}),
	).toEqual([
		{ kind: 'repo', name: 'folder', title: 'Repo' },
		{ kind: 'private', name: 'lock', title: 'Private' },
	])
})

test('rendered signifiers are icon tooltips, not text pills', async () => {
	const privateHtml = await renderToString(
		renderPackageStatusSignifiers({ isPrivate: true, isListed: false }),
	)
	expect(privateHtml).toContain('data-testid="package-visibility-badge"')
	expect(privateHtml).toContain('data-visibility="private"')
	expect(privateHtml).toContain('data-signifier="package"')
	expect(privateHtml).toContain('data-signifier="private"')
	expect(privateHtml).toContain('data-icon="lock"')
	expect(privateHtml).toContain('title="Private"')
	expect(privateHtml).toContain('title="Package"')
	expect(privateHtml).not.toContain('data-signifier="unpublished"')
	expect(privateHtml).not.toMatch(/>Private</)
	expect(privateHtml).not.toMatch(/>Not published</)

	const unpublishedHtml = await renderToString(
		renderPackageStatusSignifiers({ isPrivate: false, isListed: false }),
	)
	expect(unpublishedHtml).toContain('data-signifier="package"')
	expect(unpublishedHtml).toContain('data-signifier="unpublished"')
	expect(unpublishedHtml).toContain('data-icon="file"')
	expect(unpublishedHtml).toContain('title="Not published"')
	expect(unpublishedHtml).not.toContain('data-signifier="private"')
	expect(unpublishedHtml).not.toMatch(/>Not published</)

	const plainRepoHtml = await renderToString(
		renderPackageStatusSignifiers({
			isPrivate: false,
			isListed: false,
			hasPackage: false,
		}),
	)
	expect(plainRepoHtml).toContain('data-signifier="repo"')
	expect(plainRepoHtml).toContain('title="Repo"')
	expect(plainRepoHtml).not.toContain('data-signifier="package"')
	expect(plainRepoHtml).not.toContain('data-signifier="unpublished"')
})
