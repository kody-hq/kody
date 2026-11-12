import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { resolve } from 'node:path'

let script: string
test.beforeAll(async () => {
	const mock = `
const file={id:'file',name:'Launch',mediaType:'application/vnd.kody.page+json',updatedAt:'2026-11-06T00:00:00Z',metadataVersion:0,accessMode:'inherit'};
const state={file,access:{read:true,manage:!location.search.includes('readonly')},personal:false,direct:{collaborators:[],options:{everyone:{orgId:'org'},teams:[{id:'writers',name:'Writers'}],members:[{userId:'kent',username:'kent',displayName:'Kent'}]}},ancestors:location.search.includes('restrictedParent')?[{id:'private',name:'Private',restricted:true,grants:[]}]:[],invites:[],publicLinkEnabled:false};
export async function readFilePermissions(){return structuredClone(state)}
export async function configureFileAsset(){}
export async function createSignedFileAsset(){return {href:"/signed-asset"}}
export async function changeFileCollaborator({data}){if(data.remove){state.direct.collaborators=state.direct.collaborators.filter(g=>g.grantId!==data.grantId);return}const old=state.direct.collaborators.find(g=>g.subjectId===data.subjectId);const person={grantId:data.subjectId,subjectId:data.subjectId,subjectType:data.subjectType,kind:data.subjectType==='team'?'team':'member',label:data.subjectId==='writers'?'Writers':'Kent',permissions:data.permissions??['file:read'],preset:data.permissions?null:data.preset};if(old)Object.assign(old,person);else state.direct.collaborators.push(person);state.direct.options.teams=state.direct.options.teams.filter(t=>t.id!==data.subjectId)}
export async function manageWorkspaceFile({data}){state.file.accessMode=data.input.access_mode;state.file.metadataVersion++;return {ok:true}}
export async function shareFile({data}){state.invites.push({id:'invite',invitee_email:data.email,preset:data.preset});return {ok:true,href:'/files/invites/test'}}
export async function revokeFileInvitation(){state.invites=[];return {ok:true}}
export async function setFilePublicLink({data}){state.publicLinkEnabled=data.enabled;return {href:data.enabled?'/shared-files/test/token':null}}
`
	const result = await build({
		stdin: {
			contents: `import React from 'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import Panel from './packages/worker/start/pages/file-permissions-panel.tsx';createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><Panel item={{id:'file',name:'Launch',mediaType:'application/vnd.kody.page+json'}} orgSlug="team" onClose={()=>{}} onAccessChange={()=>{}}/></QueryClientProvider>)`,
			resolveDir: process.cwd(),
			loader: 'tsx',
		},
		bundle: true,
		write: false,
		platform: 'browser',
		format: 'iife',
		jsx: 'automatic',
		jsxImportSource: '@emotion/react',
		alias: {
			'#universal': resolve('packages/worker/universal'),
			'#client': resolve('packages/worker/client'),
		},
		define: { 'process.env.NODE_ENV': '"production"' },
		plugins: [
			{
				name: 'permissions-fixtures',
				setup(builder) {
					builder.onResolve(
						{
							filter:
								/^#start\/server\/|account-management-components\.tsx$|site-link\.tsx$/,
						},
						(args) => ({
							path: args.path.startsWith('#start/server/')
								? 'server'
								: args.path,
							namespace: 'fixture',
						}),
					)
					builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
						loader: 'tsx',
						resolveDir: process.cwd(),
						contents:
							args.path === 'server'
								? mock
								: args.path.includes('site-link')
									? 'export function SiteLink({href,children,...props}){return <a href={href} {...props}>{children}</a>}'
									: 'export const accountInputCss={width:"100%",boxSizing:"border-box"}',
					}))
				},
			},
		],
	})
	script = result.outputFiles[0]!.text
})
test.beforeEach(async ({ page }) => {
	await page.route('https://permissions.test/**', (route) =>
		route.fulfill(
			new URL(route.request().url()).pathname === '/app.js'
				? { contentType: 'application/javascript', body: script }
				: {
						contentType: 'text/html',
						body: '<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>',
					},
		),
	)
})

test('one panel manages team grants, custom permissions, invitations, restrictions, and public links', async ({
	page,
}) => {
	await page.goto('https://permissions.test/')
	const panel = page.getByRole('dialog')
	await panel.getByRole('tab', { name: 'Details', exact: true }).click()
	await expect(panel.getByText('Page', { exact: true })).toBeVisible()
	await panel.getByRole('tab', { name: 'Sharing', exact: true }).click()
	await panel
		.getByRole('combobox', { name: 'Person or team', exact: true })
		.fill('Wri')
	await panel.getByRole('option', { name: 'Writers', exact: true }).click()
	await panel.getByRole('button', { name: 'Add', exact: true }).click()
	await expect(
		panel.getByLabel('Access for Writers', { exact: true }),
	).toHaveValue('read')
	await panel
		.getByText('Custom permissions for Writers', { exact: true })
		.click()
	await panel.getByRole('checkbox', { name: 'Comment', exact: true }).check()
	await panel.getByRole('button', { name: 'Save custom permissions' }).click()
	await expect(
		panel.getByLabel('Access for Writers', { exact: true }),
	).toHaveValue('custom')
	await panel.getByRole('button', { name: 'Remove access for Writers' }).click()
	await expect(
		panel.getByLabel('Access for Writers', { exact: true }),
	).toHaveCount(0)
	await panel
		.getByRole('combobox', { name: 'Person or team', exact: true })
		.fill('Invite')
	await panel
		.getByRole('option', { name: 'Invite by email', exact: true })
		.click()
	await panel.getByLabel('Collaborator email').fill('outside@example.com')
	await panel
		.getByRole('button', { name: 'Create invite', exact: true })
		.click()
	await expect(
		panel.getByText('Pending invitation', { exact: true }),
	).toBeVisible()
	await expect(
		panel.getByLabel('Invitation link', { exact: true }),
	).toHaveValue('https://permissions.test/files/invites/test')
	await panel.getByRole('button', { name: 'Revoke', exact: true }).click()
	await expect(
		panel.getByText('Pending invitation', { exact: true }),
	).toHaveCount(0)
	await panel
		.getByRole('combobox', { name: 'General access', exact: true })
		.selectOption('restricted')
	await expect(
		panel.getByRole('combobox', { name: 'General access', exact: true }),
	).toHaveValue('restricted')
	await panel
		.getByRole('button', { name: 'Create public link', exact: true })
		.click()
	await expect(panel.getByLabel('Public link URL')).toHaveValue(
		'https://permissions.test/shared-files/test/token',
	)
	await panel.getByRole('button', { name: 'Revoke', exact: true }).click()
	await expect(panel.getByText('Not public', { exact: true })).toBeVisible()
})

test('restricted parents block public links and read-only viewers cannot edit permissions', async ({
	page,
}) => {
	await page.goto('https://permissions.test/?restrictedParent')
	await expect(
		page.getByRole('button', { name: 'Create public link', exact: true }),
	).toBeDisabled()
	await expect(
		page.getByText('A grant here cannot bypass', { exact: false }),
	).toBeVisible()
	await page.goto('https://permissions.test/?readonly')
	await expect(
		page.getByRole('combobox', { name: 'General access', exact: true }),
	).toBeDisabled()
	await expect(
		page.getByRole('button', { name: 'Create public link', exact: true }),
	).toHaveCount(0)
	await expect(page.getByLabel('Person or team', { exact: true })).toHaveCount(
		0,
	)
})
