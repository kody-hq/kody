import { expect, test } from 'vitest'
import { jsx } from 'react/jsx-runtime'
import { renderStartPage as renderToString } from '../test-support/render-start-page.ts'
import { PackageFilesExplorer } from '../components/package-files-explorer.tsx'
import { type PackageFilesLoaderData } from '#universal/loader-data.ts'

function tabbedFileData(): PackageFilesLoaderData {
	const code = '\t\t<Button'
	return {
		ok: true,
		title: 'tab-width-fixture',
		backHref: '/@jane/tab-width-fixture',
		backLabel: 'Code',
		filesBasePath: '/@jane/tab-width-fixture/tree/main',
		selectedPath: 'example.tsx',
		kind: 'file',
		paths: ['example.tsx'],
		children: [{ name: 'example.tsx', path: 'example.tsx', kind: 'file' }],
		content: code,
		contentPath: 'example.tsx',
		contentKind: 'code',
		language: 'tsx',
		contentHighlighted: {
			code,
			lang: 'tsx',
			plain: false,
			fg: '#24292e',
			bg: '#fff',
			lines: [[{ content: '\t' }, { content: '\t' }, { content: '<Button' }]],
		},
		username: 'jane',
		kodyId: 'tab-width-fixture',
		viewerIsOwner: true,
		isPrivate: false,
		isListed: false,
	}
}

test('file views link to the raw file and directory views do not', async () => {
	const html = await renderToString(
		jsx(PackageFilesExplorer, {
			data: {
				...tabbedFileData(),
				rawHref: '/@jane/tab-width-fixture/raw/main/example.tsx',
			},
		}),
	)
	expect(html).toMatch(
		/<a[^>]*href="\/@jane\/tab-width-fixture\/raw\/main\/example\.tsx"[^>]*>Raw<\/a>/,
	)
	expect(html).toContain('aria-label="View raw example.tsx"')

	const directoryHtml = await renderToString(
		jsx(PackageFilesExplorer, {
			data: {
				...tabbedFileData(),
				kind: 'directory',
				selectedPath: '',
				content: null,
				contentPath: null,
				contentKind: null,
				rawHref: null,
			},
		}),
	)
	expect(directoryHtml).not.toContain('package-files-raw-link')
})

test('file links keep the picked install org from ?org', async () => {
	const html = await renderToString(
		jsx(PackageFilesExplorer, { data: tabbedFileData() }),
		'/@jane/tab-width-fixture/tree/main?org=example-team',
	)
	expect(html).toContain(
		'href="/@jane/tab-width-fixture/tree/main/example.tsx?org=example-team"',
	)
})
