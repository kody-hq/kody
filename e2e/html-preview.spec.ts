import { test, expect } from '@playwright/test'
import {
	htmlPreviewCsp,
	htmlPreviewBootstrap,
} from '../packages/worker/universal/html-preview.ts'

test('HTML scripts run in an opaque sandbox with no parent access or network navigation', async ({
	page,
}) => {
	const content = `<body><button onclick="this.textContent='clicked'">Run</button><pre id="results"></pre><script>
const results = {};
for (const [name, action] of Object.entries({parent:()=>top.document.body, cookie:()=>document.cookie, storage:()=>localStorage.length, topNavigation:()=>top.location.href='https://preview.test/escape'})) {
 try { action(); results[name]='allowed' } catch { results[name]='blocked' }
}
results.script='ran';
parent.postMessage({type:'kody-html-preview', content:'ESCAPED'}, '*');
document.querySelector('#results').textContent=JSON.stringify(results);
fetch('https://preview.test/fetch').catch(()=>{});
const img=new Image(); img.src='https://preview.test/image';
</script><a href="https://preview.test/navigation">Navigate</a></body>`
	const requests: string[] = []
	await page.route('https://preview.test/**', async (route) => {
		const path = new URL(route.request().url()).pathname
		requests.push(path)
		if (path === '/')
			return route.fulfill({
				contentType: 'text/html',
				body: `<body><iframe title="preview" sandbox="allow-scripts" src="/wrapper"></iframe><script>document.querySelector('iframe').addEventListener('load', () => document.querySelector('iframe').contentWindow.postMessage({type:'kody-html-preview',content:${JSON.stringify(content).replaceAll('<', '\\u003c')}}, '*'))</script></body>`,
			})
		if (path === '/wrapper')
			return route.fulfill({
				contentType: 'text/html',
				headers: { 'Content-Security-Policy': htmlPreviewCsp },
				body: htmlPreviewBootstrap('https://preview.test'),
			})
		return route.fulfill({ body: 'escaped' })
	})
	await page.goto('https://preview.test/')
	const document = page
		.frameLocator('iframe[title="preview"]')
		.frameLocator('iframe')
	await expect(document.locator('#results')).toHaveText(
		JSON.stringify({
			parent: 'blocked',
			cookie: 'blocked',
			storage: 'blocked',
			topNavigation: 'blocked',
			script: 'ran',
		}),
	)
	await document.getByRole('button', { name: 'Run' }).click()
	await expect(document.getByRole('button')).toHaveText('clicked')
	await document.getByRole('link', { name: 'Navigate' }).click()
	await expect(page).toHaveURL('https://preview.test/')
	expect(requests).toEqual(['/', '/wrapper'])
})
