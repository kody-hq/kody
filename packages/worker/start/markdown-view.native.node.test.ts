import { jsx } from 'react/jsx-runtime'
import { renderStartPage } from './test-support/render-start-page.ts'
import { type ReactNode } from 'react'
const renderToString = (page: ReactNode) => renderStartPage(page, '/docs')
import { expect, test } from 'vitest'
import { renderMarkdownNodes } from './components/markdown-view.tsx'
async function renderMarkdown(markdown: string) {
	return renderToString(jsx('div', { children: renderMarkdownNodes(markdown) }))
}

test('markdown safety escapes raw HTML, never emits images, and drops unsafe links', async () => {
	const html = await renderMarkdown(
		[
			'<script>alert(1)</script>',
			'',
			'inline <img src="https://evil.example/x.png" onerror="alert(1)"> html',
			'',
			'<iframe src="https://evil.example"></iframe>',
			'',
			'![badge](https://img.example/badge.svg) and ![local](/logo.png)',
			'',
			'[bad-proto](javascript:alert(1))',
			'',
			'[data-proto](data:text/html,hi)',
			'',
			'[relative](/account/secrets)',
			'',
			'[package-endpoint](https://heykody.dev/@mallory/packages/tracker/app)',
			'',
			'[good](https://example.com/docs) and <https://example.com/auto>',
		].join('\n'),
	)

	expect(html).not.toContain('<script')
	expect(html).not.toContain('<img')
	expect(html).not.toContain('<iframe')
	expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
	// Comment-only HTML (guide agent notes) renders as nothing — it must not
	// leak into the page as literal text.
	const withComments = await renderMarkdown(
		'before\n\n<!--\nagent notes: hidden\n-->\n\nafter <!-- inline note --> end',
	)
	expect(withComments).toContain('before')
	expect(withComments).toContain('after')
	expect(withComments).not.toContain('agent notes')
	expect(withComments).not.toContain('inline note')
	expect(withComments).not.toContain('&lt;!--')
	expect(html).toContain('&lt;img src=')
	expect(html).toContain(
		'<a href="https://img.example/badge.svg" target="_blank" rel="noopener noreferrer nofollow ugc">badge</a>',
	)
	expect(html).toContain('<span>local</span>')
	expect(html).not.toContain('/logo.png')
	expect(html).not.toContain('javascript:')
	expect(html).not.toContain('data:text/html')
	expect(html).not.toContain('/account/secrets')
	expect(html).not.toContain('@mallory')
	expect(html).toContain('<span>bad-proto</span>')
	expect(html).toContain('<span>package-endpoint</span>')
	expect(html).toContain(
		'<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer nofollow ugc">good</a>',
	)
	expect(html).toContain('https://example.com/auto</a>')
})

test('package README imageBaseHref emits img only for in-repo relative images', async () => {
	const markdown = [
		'![poster](./docs/poster.png)',
		'',
		'![nested](poster.png)',
		'',
		'![remote](https://img.example/badge.svg)',
		'',
		'![escape](../secret.png)',
		'',
		'![code](./src/index.ts)',
	].join('\n')

	const withAssets = await renderToString(
		jsx('div', {
			children: renderMarkdownNodes(markdown, {
				imageBaseHref: '/@kody/doom/assets',
				imageFromDirectory: '',
			}),
		}),
	)
	expect(withAssets).toContain(
		'<img src="/@kody/doom/assets/docs/poster.png" alt="poster"',
	)
	expect(withAssets).toContain(
		'<img src="/@kody/doom/assets/poster.png" alt="nested"',
	)
	expect(withAssets).not.toContain('<img src="https://img.example')
	expect(withAssets).toContain(
		'<a href="https://img.example/badge.svg" target="_blank" rel="noopener noreferrer nofollow ugc">remote</a>',
	)
	expect(withAssets).toContain('<span>escape</span>')
	expect(withAssets).not.toContain('secret.png')
	expect(withAssets).not.toContain('src/index.ts')

	const fromDocs = await renderToString(
		jsx('div', {
			children: renderMarkdownNodes('![poster](./poster.png)', {
				imageBaseHref: '/@kody/doom/assets',
				imageFromDirectory: 'docs',
			}),
		}),
	)
	expect(fromDocs).toContain(
		'<img src="/@kody/doom/assets/docs/poster.png" alt="poster"',
	)

	const defaultPolicy = await renderMarkdown('![poster](./docs/poster.png)')
	expect(defaultPolicy).not.toContain('<img')
	expect(defaultPolicy).toContain('<span>poster</span>')
})

test('first-party heading ids are unique and use parsed heading text', async () => {
	const html = await renderToString(
		jsx('div', {
			children: renderMarkdownNodes(
				'## Josh Tomaino\n\n## Josh Tomaino\n\n## **Install** `CLI`',
				{ headingOffset: 0, headingIds: true },
			),
		}),
	)

	expect(html).toContain('id="josh-tomaino"')
	expect(html).toContain('id="josh-tomaino-2"')
	expect(html).toContain('aria-label="Install CLI"')
})

test('rendered markdown links allowlist protocols and block user-scope paths', async () => {
	const allowed: Array<[string, string]> = [
		['https://example.com/a', 'https://example.com/a'],
		['http://example.com', 'http://example.com/'],
		['mailto:kody@example.com', 'mailto:kody@example.com'],
		// Benign encoded paths that decode to non-user-scope stay allowed.
		['https://example.com/a%20b', 'https://example.com/a%20b'],
		// Paths that merely contain (not start with) a `packages` segment stay
		// allowed — only the mount shape is refused.
		[
			'https://github.com/orgs/example/packages',
			'https://github.com/orgs/example/packages',
		],
	]
	for (const [href, expected] of allowed) {
		const html = await renderMarkdown(`[safe](${href})`)
		expect(html).toContain(`href="${expected}"`)
	}

	const refused = [
		'javascript:alert(1)',
		'vbscript:x',
		'data:text/html,hi',
		'/relative/path',
		'relative/path',
		'//protocol-relative.example',
		'https://heykody.dev/@user/packages/app',
		'https://other.example/@user/anything',
		// Repeated slashes collapse in worker routing
		// (`split('/').filter(Boolean)`), so `//@user` must be refused too.
		'https://heykody.dev//@user/packages/app',
		'https://heykody.dev///@user/packages/app',
		// Percent-encoded (and nested-encoded) user scopes must be refused:
		// URL.pathname does not decode, but the server does.
		'https://heykody.dev/%40user/packages/app',
		'https://heykody.dev/%2540user/packages/app',
		'https://heykody.dev/%25252540user/packages/app',
		'https://heykody.dev/%2F@user/x',
		// Undecodable paths fail closed.
		'https://heykody.dev/%E0%A4%A',
		// The per-user package-app subdomain mounts apps at `/packages/...`, so
		// that path shape is refused on every host too (this module cannot know
		// the deployment's package-app domain; same trade-off as the `/@` rule).
		'https://mallory.kodyapps.dev/packages/tracker',
		'https://mallory.kodyapps.dev/packages/tracker/app',
		'https://other.example/packages/x',
		'https://other.example//packages/x',
		'https://other.example/%70ackages/x',
	]
	for (const href of refused) {
		const html = await renderMarkdown(`[unsafe](${href})`)
		expect(html).not.toContain('<a ')
	}
})

test('first-party guides render tip callouts and details; untrusted markdown stays escaped', async () => {
	const markdown = [
		'> [!TIP]',
		'> Prefer a [fork](/docs/package-lifecycle) for most use cases.',
		'',
		'<details>',
		'<summary>What is the difference between forking and sharing?</summary>',
		'',
		'**Fork** copies the package. **Share** leaves it in your account.',
		'',
		'</details>',
		'',
		'<details onclick="alert(1)">',
		'<summary>Bad</summary>',
		'',
		'Nope',
		'',
		'</details>',
	].join('\n')

	const firstParty = await renderToString(
		jsx('div', {
			children: renderMarkdownNodes(markdown, {
				linkPolicy: 'first-party',
				headingOffset: 0,
			}),
		}),
	)
	expect(firstParty).toContain('data-doc-callout="tip"')
	expect(firstParty).toContain('<strong>Tip</strong>')
	expect(firstParty).toContain('href="/docs/package-lifecycle"')
	expect(firstParty).not.toContain('[!TIP]')
	expect(firstParty).toContain('<details')
	expect(firstParty).toContain('data-doc-disclosure')
	expect(firstParty).toContain(
		'<summary>What is the difference between forking and sharing?</summary>',
	)
	expect(firstParty).toContain('<strong>Fork</strong>')
	expect(firstParty).toContain('<strong>Share</strong>')
	expect(firstParty).toContain('&lt;details onclick=&quot;alert(1)&quot;&gt;')
	expect(firstParty).not.toContain('<details onclick')

	const untrusted = await renderMarkdown(markdown)
	expect(untrusted).toContain('<blockquote>')
	expect(untrusted).toContain('[!TIP]')
	expect(untrusted).not.toContain('data-doc-callout')
	expect(untrusted).not.toContain('<details')
	expect(untrusted).toContain('&lt;details')
	expect(untrusted).toContain('&lt;summary')
})

test('first-party watch blocks render a lite youtube player; untrusted markdown stays a quote', async () => {
	const markdown = [
		'> [!WATCH] https://youtu.be/_EJTrJFLa3g',
		'> Watch: Make your agent safe and autonomous',
		'',
		'> [!WATCH] https://example.com/watch?v=_EJTrJFLa3g',
		'> Watch: Not YouTube',
	].join('\n')

	const firstParty = await renderToString(
		jsx('div', {
			children: renderMarkdownNodes(markdown, {
				linkPolicy: 'first-party',
				headingOffset: 0,
				linkRel: 'noopener noreferrer',
			}),
		}),
	)
	expect(firstParty).toContain('data-doc-youtube')
	expect(firstParty).toContain('data-testid="doc-youtube-play"')
	expect(firstParty).toContain('/youtube-thumb/_EJTrJFLa3g')
	expect(firstParty).toContain('Play Make your agent safe and autonomous')
	expect(firstParty).toContain(
		'href="https://www.youtube.com/watch?v=_EJTrJFLa3g"',
	)
	expect(firstParty).toContain('Watch: Make your agent safe and autonomous')
	expect(firstParty).not.toContain('youtube-nocookie.com')
	expect(firstParty).not.toContain('[!WATCH] https://youtu.be/_EJTrJFLa3g')
	expect(firstParty).toContain('<blockquote>')
	expect(firstParty).toContain('Not YouTube')

	const untrusted = await renderMarkdown(markdown)
	expect(untrusted).not.toContain('data-doc-youtube')
	expect(untrusted).not.toContain('youtube-nocookie.com')
	expect(untrusted).toContain('[!WATCH]')
	expect(untrusted).toContain('<blockquote>')
})

test('first-party diagram blocks render a registered figure with the quote as its caption', async () => {
	const markdown = [
		'> [!DIAGRAM] placeholder-fill',
		'> Your code sends `{{secret:github}}` and the gateway fills it.',
		'',
		'> [!DIAGRAM] not-a-diagram',
		'> Unknown ids stay a quote.',
	].join('\n')

	const firstParty = await renderToString(
		jsx('div', {
			children: renderMarkdownNodes(markdown, {
				linkPolicy: 'first-party',
				headingOffset: 0,
			}),
		}),
	)
	expect(firstParty).toContain('data-doc-diagram="placeholder-fill"')
	expect(firstParty).toMatch(
		/<figcaption[^>]*><p>Your code sends <code>\{\{secret:github\}\}<\/code> and the gateway fills it\.<\/p><\/figcaption>/,
	)
	expect(firstParty).toContain('Kody gateway')
	expect(firstParty).toMatch(
		/<blockquote><p>\[!DIAGRAM\] not-a-diagram\nUnknown ids stay a quote\.<\/p><\/blockquote>/,
	)

	const untrusted = await renderMarkdown(markdown)
	expect(untrusted).not.toContain('data-doc-diagram')
	expect(untrusted).toContain('[!DIAGRAM] placeholder-fill')
})

test('markdown preserves tables, tight task lists, entities, and reference links', async () => {
	const html = await renderMarkdown(
		[
			'| Name | Value |',
			'| :--- | ---: |',
			'| **Key** | `42` |',
			'',
			'- [x] Done',
			'- [ ] Pending',
			'',
			'Fish &amp; chips, [guide][ref].',
			'',
			'[ref]: https://example.com/docs',
		].join('\n'),
	)
	expect(html).toContain('<table>')
	expect(html).toContain('<strong>Key</strong>')
	expect(html).toContain('<code>42</code>')
	expect(html).toContain('text-align:right')
	expect(html).toContain('type="checkbox" disabled="" checked=""')
	expect(html).not.toContain('<li><p>')
	expect(html).toContain('Fish &amp; chips')
	expect(html).not.toContain('&amp;amp;')
	expect(html).toContain('href="https://example.com/docs"')
})

test('markdown renders footnote text and links', async () => {
	const html = await renderMarkdown(
		'A claim[^source].\n\n[^source]: Supporting evidence.',
	)
	expect(html).toContain('Supporting evidence.')
	expect(html).toContain('aria-label="Footnotes"')
	expect(html).toMatch(/href="#markdown-footnote-[^"]+"/)
})
