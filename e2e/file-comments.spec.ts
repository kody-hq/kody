import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { build } from 'esbuild'
import { peleAsset } from './pele-asset.ts'
import { resolve } from 'node:path'

let script: string
test.beforeAll(async () => {
	const result = await build({
		stdin: {
			loader: 'tsx',
			resolveDir: process.cwd(),
			contents: `
import React,{useState,useRef}from'react';import{createRoot}from'react-dom/client';
import{Awareness}from'y-protocols/awareness';import{FileComments}from'./packages/worker/start/pages/file-comments.tsx';import{WorkspacePageEditor}from'./packages/worker/start/pages/workspace-page-editor.tsx';import{createCollaborativeDocument}from'./packages/worker/universal/collaborative-document.ts';
const self={id:'jane',personId:'jane',name:'jane',kind:'person',profileId:null,runId:null},kent={...self,id:'kent',personId:'kent',name:'kent'};
const blocks=['Confirm the launch date with Kent.','Review the invitation before sending.'].map((text,i)=>({id:'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),kind:'paragraph',text}));const content=JSON.stringify({version:1,blocks});const doc=createCollaborativeDocument(content,'application/vnd.kody.page+json');const room={doc,awareness:new Awareness(doc),getSnapshot:()=>({snapshot:{actor:self,revisionId:'revision'}})};
const initialThreads=blocks.map((block,i)=>({id:'thread-'+i,fileId:'file',anchor:{kind:'block',blockId:block.id,quote:block.text},anchorVersion:1,revisionId:'revision',createdAt:'2026-11-06T00:00:00Z',createdBy:kent,resolvedAt:i?'2026-11-06T01:00:00Z':null,resolvedBy:i?self:null,version:0,outdated:false}));
const initialComments=initialThreads.map((thread,i)=>({id:'comment-'+i,threadId:thread.id,body:i?'Invitation reviewed.':'Please check the date, @jane.',author:i?self:kent,createdAt:thread.createdAt,editedAt:null,deletedAt:null,version:0}));
function App(){const root=useRef(null),fail=useRef(false);const[threads,setThreads]=useState(initialThreads),[comments,setComments]=useState(initialComments),[open,setOpen]=useState(false),[active,setActive]=useState(null),[composing,setComposing]=useState(false),[anchor,setAnchor]=useState({kind:'file'}),[error,setError]=useState(''),[notifications,setNotifications]=useState([{id:'notice',threadId:'thread-0',read:false}]);
function select(thread){setActive(thread.id);setAnchor(thread.anchor);setComposing(false);setOpen(true);setNotifications([])}
function start(value){setAnchor(value);setActive(null);setComposing(true);setOpen(true)}
function close(){setOpen(false);setActive(null);setComposing(false);requestAnimationFrame(()=>root.current?.querySelector('[aria-label="Page content"]')?.focus({preventScroll:true}))}
async function run(command){setError('');await new Promise(resolve=>setTimeout(resolve,30));if(fail.current){fail.current=false;setError('Connection lost. Try again.');return false}const now=new Date().toISOString();if(command.kind==='create'){setThreads(all=>[...all,{...initialThreads[0],id:command.threadId,anchor:command.anchor,createdBy:self,createdAt:now}]);setComments(all=>[...all,{...initialComments[0],id:command.commentId,threadId:command.threadId,body:command.body,author:self,createdAt:now}])}else if(command.kind==='reply'){setComments(all=>[...all,{...initialComments[0],id:command.commentId,threadId:command.threadId,body:command.body,author:self,createdAt:now}])}else if(command.kind==='resolve'){setThreads(all=>all.map(thread=>thread.id===command.threadId?{...thread,version:thread.version+1,resolvedAt:command.resolved?now:null,resolvedBy:command.resolved?self:null}:thread))}else if(command.kind==='edit'){setComments(all=>all.map(comment=>comment.id===command.commentId?{...comment,version:comment.version+1,body:command.body,editedAt:now}:comment))}else if(command.kind==='remove'){setComments(all=>all.map(comment=>comment.id===command.commentId?{...comment,body:'',deletedAt:now,version:comment.version+1}:comment))}return true}
return <><header><output aria-label="Comment anchor">{anchor.kind}</output><button onClick={()=>setOpen(true)}>Comments</button><button onClick={()=>{fail.current=true}}>Fail next save</button></header><main style={{display:'grid',gridTemplateColumns:open?'minmax(0,1fr) 300px':'minmax(0,1fr)',gap:24,padding:32}}><div ref={root}><h1>Launch</h1><WorkspacePageEditor content={content} onChange={()=>{}} collaboration={room} files={[]} renderFile={()=>null} threads={threads} activeThreadId={open?active:null} draftAnchor={composing?anchor:undefined} onSelectThread={select} onComment={start}/></div>{open&&<FileComments threads={threads} comments={comments} actor={self} actors={[self,kent]} canComment={true} manage={true} notifications={notifications} activeId={active} composing={composing} anchor={anchor} draftScope="test.comment-draft" onSelect={select} onCreated={(id,value)=>{setActive(id);setAnchor(value);setComposing(false)}} onBack={()=>{setActive(null);setComposing(false)}} onClose={close} onNew={()=>start({kind:'file'})} run={run} commandError={error} documentRoot={root} moreThreads={false} moreComments={false} loadThreads={async()=>{}} loadComments={async()=>{}}/>}</main></>};createRoot(document.getElementById('root')).render(<App/>);
`,
		},
		bundle: true,
		plugins: [peleAsset],
		write: false,
		platform: 'browser',
		format: 'iife',
		jsx: 'automatic',
		jsxImportSource: '@emotion/react',
		alias: { '#universal': resolve('packages/worker/universal') },
		define: { 'process.env.NODE_ENV': '"production"' },
	})
	script = result.outputFiles[0]!.text
})
test.beforeEach(async ({ page }) => {
	await page.route('https://comments.test/**', (route) =>
		route.fulfill(
			new URL(route.request().url()).pathname === '/app.js'
				? { contentType: 'application/javascript', body: script }
				: {
						contentType: 'text/html',
						body: `<!doctype html><html lang="en"><head><title>Comment interaction fixture</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--color-primary:#178b4a;--color-primary-text:#126835;--color-surface:#fff;--color-background:#fff;--color-text:#202124;--color-text-muted:#62676e;--color-border:#ddd;--color-danger:#b22;--font-family:system-ui;--font-family-mono:monospace;--font-size-xs:12px;--font-size-sm:14px}body{font:14px system-ui;margin:0}button,textarea,select{font:inherit}@media(max-width:760px){main{grid-template-columns:minmax(0,1fr)!important}}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`,
					},
		),
	)
})

test('selection creates a real Yjs text anchor, focuses the composer, and preserves document focus when reopening a thread', async ({
	page,
}) => {
	const errors: string[] = []
	page.on('pageerror', (error) => errors.push(error.message))
	await page.goto('https://comments.test/')
	const editor = page.getByRole('textbox', { name: 'Page content' })
	await editor.focus()
	await editor.press('ControlOrMeta+Home')
	await editor.press('Shift+End')
	await expect(
		page.getByRole('button', { name: 'Comment on selection', exact: true }),
	).toBeVisible()
	await page
		.getByRole('button', { name: 'Comment on selection', exact: true })
		.click()
	const composer = page.getByRole('combobox', {
		name: 'New comment',
		exact: true,
	})
	await expect(composer).toBeFocused()
	await expect(page.locator('[data-comment-draft]').first()).toBeVisible()
	await expect(page.getByLabel('Comment anchor')).toHaveText('text')
	await composer.fill('The date is confirmed.')
	await composer.press('ControlOrMeta+Enter')
	await expect(
		page.getByText('The date is confirmed.', { exact: true }),
	).toBeVisible()
	await expect(
		page.getByRole('combobox', { name: 'Reply to discussion' }),
	).toBeFocused()
	await page
		.getByRole('button', { name: 'Close comments', exact: true })
		.click()
	await expect(editor).toBeFocused()
	await page
		.locator('[data-page-block-id]')
		.first()
		.locator('.block-text')
		.click()
	await expect(
		page.getByRole('complementary', { name: 'File comments' }),
	).toBeVisible()
	await expect(editor).toBeFocused()
	expect(errors).toEqual([])
})

test('mentions, retry drafts, reply, resolve, undo, and filters work with the keyboard', async ({
	page,
}) => {
	await page.goto('https://comments.test/')
	await page.getByRole('button', { name: 'Comments', exact: true }).click()
	await page.getByRole('combobox', { name: 'Filter discussions' }).click()
	await page.getByRole('option', { name: 'Unread', exact: true }).click()
	await page
		.getByRole('button', {
			name: 'Open discussion by kent, unread',
			exact: true,
		})
		.click()
	const reply = page.getByRole('combobox', { name: 'Reply to discussion' })
	await reply.fill('@ke')
	await expect(
		page.getByRole('option', { name: '@kent', exact: true }),
	).toBeVisible()
	await reply.press('Enter')
	await expect(reply).toHaveValue('@kent ')
	await reply.press('End')
	await reply.pressSequentially('Thanks, confirmed.')
	await page.getByRole('button', { name: 'Fail next save' }).click()
	await page.getByRole('button', { name: 'Send reply', exact: true }).click()
	await expect(page.getByRole('alert')).toContainText('Connection lost')
	await expect(reply).toHaveValue('@kent Thanks, confirmed.')
	await reply.press('ControlOrMeta+Enter')
	await expect(reply).toHaveValue('')
	await expect(
		page.getByRole('article', { name: 'Comment by jane' }),
	).toContainText('Thanks, confirmed.')
	await page
		.getByRole('button', { name: 'Resolve discussion', exact: true })
		.focus()
	await page
		.getByRole('button', { name: 'Resolve discussion', exact: true })
		.click()
	await expect(
		page.getByRole('status').filter({ hasText: 'Discussion resolved' }),
	).toBeVisible()
	await page.getByRole('button', { name: 'Undo', exact: true }).click()
	await expect(
		page.getByRole('button', { name: 'Resolve discussion', exact: true }),
	).toBeVisible()
	await reply.focus()
	await reply.press('Escape')
	await expect(
		page.getByRole('complementary', { name: 'File comments' }),
	).toHaveCount(0)
	await page.getByRole('button', { name: 'Comments', exact: true }).click()
	await page.getByRole('combobox', { name: 'Filter discussions' }).click()
	await page.getByRole('option', { name: 'Resolved', exact: true }).click()
	await expect(
		page.getByText('Invitation reviewed.', { exact: true }),
	).toBeVisible()
})

test('failed edits stay editable and explicit cancel discards the edit draft', async ({
	page,
}) => {
	await page.goto('https://comments.test/')
	await page.getByRole('button', { name: 'Comments', exact: true }).click()
	await page.getByRole('combobox', { name: 'Filter discussions' }).click()
	await page.getByRole('option', { name: 'Resolved', exact: true }).click()
	await page
		.getByRole('button', { name: 'Open discussion by kent', exact: true })
		.click()
	await page
		.getByRole('button', { name: 'Actions for comment by jane', exact: true })
		.focus()
	await page
		.getByRole('button', { name: 'Actions for comment by jane', exact: true })
		.click()
	await page
		.getByRole('menuitem', { name: 'Edit', exact: true })
		.press('Escape')
	await expect(
		page.getByRole('button', {
			name: 'Actions for comment by jane',
			exact: true,
		}),
	).toBeFocused()
	await expect(
		page.getByRole('complementary', { name: 'File comments' }),
	).toBeVisible()
	await page
		.getByRole('button', { name: 'Actions for comment by jane', exact: true })
		.click()
	await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
	const edit = page.getByRole('combobox', { name: 'Edit comment', exact: true })
	await edit.fill('Revised invitation review.')
	await page.getByRole('button', { name: 'Fail next save' }).click()
	await page.getByRole('button', { name: 'Save comment', exact: true }).click()
	await expect(page.getByRole('alert')).toContainText('Connection lost')
	await expect(edit).toHaveValue('Revised invitation review.')
	await page.getByRole('button', { name: 'Cancel', exact: true }).click()
	await page
		.getByRole('button', { name: 'Actions for comment by jane', exact: true })
		.click()
	await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
	await expect(edit).toHaveValue('Invitation reviewed.')
})

test('mobile comments stay inside the viewport and expose accessible controls', async ({
	page,
}) => {
	await page.setViewportSize({ width: 430, height: 780 })
	await page.goto('https://comments.test/')
	await page.getByRole('button', { name: 'Comments', exact: true }).click()
	await page
		.getByRole('button', {
			name: 'Open discussion by kent, unread',
			exact: true,
		})
		.click()
	const panel = page.getByRole('complementary', { name: 'File comments' })
	await expect
		.poll(async () => {
			const rect = await panel.boundingBox()
			return rect
				? Math.max(
						-rect.x,
						rect.x + rect.width - 430,
						rect.y + rect.height - 780,
					)
				: Infinity
		})
		.toBeLessThanOrEqual(1)
	await expect(
		page.getByRole('button', { name: 'Send reply', exact: true }),
	).toBeVisible()
	const audit = await new AxeBuilder({ page })
		.include('[aria-label="File comments"]')
		.analyze()
	expect(
		audit.violations.filter(
			(item) => item.impact === 'critical' || item.impact === 'serious',
		),
	).toEqual([])
})

test('the block picker searches descriptions and inserts the highlighted block with Enter', async ({
	page,
}) => {
	await page.goto('https://comments.test/')
	const addBlock = page.getByRole('button', { name: 'Add block', exact: true })
	await addBlock.click()
	const search = page.getByRole('combobox', { name: 'Search blocks and files' })
	await expect(search).toBeFocused()
	await search.press('Escape')
	await expect(addBlock).toBeFocused()
	await addBlock.press('Enter')
	await expect(search).toBeFocused()
	await search.fill('preserve code')
	await expect(page.getByRole('option')).toHaveCount(1)
	await search.press('Enter')
	await expect(search).toHaveCount(0)
	await expect(
		page.locator('[aria-label="Page content"] [data-kind="code"]'),
	).toHaveCount(1)
})
