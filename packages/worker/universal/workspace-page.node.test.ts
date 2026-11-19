import { expect, test } from 'vitest'
import {
	patchWorkspacePage,
	readWorkspacePage,
	workspacePageMarkdown,
	writeWorkspacePage,
} from './workspace-page.ts'
const a = '00000000-0000-4000-8000-000000000001'
const b = '00000000-0000-4000-8000-000000000002'
const c = '00000000-0000-4000-8000-000000000003'

test('block batches preserve ids and unrelated blocks, and reject broken anchors atomically', () => {
	const content = writeWorkspacePage([
		{ id: a, kind: 'paragraph', text: 'Keep this' },
		{ id: b, kind: 'task', text: 'Do this' },
	])
	const updated = patchWorkspacePage(content, [
		{
			kind: 'replace',
			block: { id: b, kind: 'task', text: 'Done', checked: true },
		},
		{
			kind: 'insert',
			after_id: b,
			block: { id: c, kind: 'heading', text: 'Next' },
		},
		{ kind: 'move', block_id: c, after_id: null },
	])
	expect(readWorkspacePage(updated)?.blocks).toEqual([
		{ id: c, kind: 'heading', text: 'Next' },
		{ id: a, kind: 'paragraph', text: 'Keep this' },
		{ id: b, kind: 'task', text: 'Done', checked: true },
	])
	expect(() =>
		patchWorkspacePage(content, [
			{ kind: 'remove', block_id: b },
			{ kind: 'move', block_id: a, after_id: c },
		]),
	).toThrow('destination not found')
	expect(readWorkspacePage(content)?.blocks).toHaveLength(2)
	expect(() =>
		patchWorkspacePage(content, [
			{
				kind: 'insert',
				after_id: null,
				block: { id: a, kind: 'paragraph', text: 'Duplicate' },
			},
		]),
	).toThrow('already exists')
	expect(() =>
		patchWorkspacePage(content, [{ kind: 'move', block_id: a, after_id: a }]),
	).toThrow('itself')
})

test('Markdown exports preserve tasks, multiline quotes, literal markup, code fences and attachment links', () => {
	const content = writeWorkspacePage([
		{ id: a, kind: 'task', text: 'Ship *literal* text', checked: true },
		{ id: b, kind: 'quote', text: 'First\nSecond' },
		{ id: c, kind: 'code', text: '```js\nconst value = 1\n```' },
		{ id: '00000000-0000-4000-8000-000000000004', kind: 'file', fileId: a },
	])
	const exported = workspacePageMarkdown('Launch', content, [
		{ id: a, name: 'Report.csv', href: 'https://example.test/files?id=' + a },
	])
	expect(exported).toContain('- [x] Ship \\*literal\\* text')
	expect(exported).toContain('> First\n> Second')
	expect(exported).toContain('````\n```js\nconst value = 1\n```\n````')
	expect(exported).toContain(
		'[Report.csv](<https://example.test/files?id=' + a + '>)',
	)
})

test('Markdown exports stable heading links, numbered runs, link cards and Mermaid source', () => {
	const content = writeWorkspacePage([
		{ id: a, kind: 'contents' },
		{ id: b, kind: 'heading', text: 'Launch plan' },
		{ id: c, kind: 'numbered', text: 'Draft' },
		{ id: crypto.randomUUID(), kind: 'numbered', text: 'Publish' },
		{
			id: crypto.randomUUID(),
			kind: 'link',
			title: 'Project plan',
			text: 'https://example.com/plan',
		},
		{ id: crypto.randomUUID(), kind: 'numbered', text: 'Review' },
		{ id: crypto.randomUUID(), kind: 'mermaid', text: 'flowchart LR\nA --> B' },
	])
	const markdown = workspacePageMarkdown('Launch', content, [])
	expect(markdown).toContain(`[Launch plan](#block-${b})`)
	expect(markdown).toContain(`<a id="block-${b}"></a>`)
	expect(markdown).toContain('1. Draft\n2. Publish')
	expect(markdown).toContain(
		'[Project plan](<https://example.com/plan>)\n\n1. Review',
	)
	expect(markdown).toContain('```mermaid\nflowchart LR\nA --> B\n```')
})
