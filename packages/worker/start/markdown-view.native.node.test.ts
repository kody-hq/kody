import { jsx } from 'react/jsx-runtime'
import { renderStartPage } from './test-support/render-start-page.ts'
import { type ReactNode } from 'react'
const renderToString = (page: ReactNode) => renderStartPage(page, '/docs')
import { expect, test } from 'vitest'
import { renderMarkdownNodes } from './components/markdown-view.tsx'
async function renderMarkdown(markdown: string) {
	return renderToString(jsx('div', { children: renderMarkdownNodes(markdown) }))
}

test('renders common markdown constructs as HTML elements', async () => {
	const html = await renderMarkdown(
		[
			'# Title',
			'',
			'#### Deep heading',
			'',
			'Some **bold** and *italic* and ~~gone~~ and `inline code` text.',
			'',
			'> a quote',
			'',
			'- first',
			'- [x] done task',
			'',
			'5. five',
			'6. six',
			'',
			'| Name | Count |',
			'| :--- | ----: |',
			'| a    | 1     |',
			'',
			'```js',
			'const x = 1',
			'```',
			'',
			'---',
			'',
			'Entities: &amp; &#65; stay characters.',
		].join('\n'),
	)

	// Headings are demoted below the page-owned h1/h2 and clamped at h6.
	expect(html).toContain('<h3>Title</h3>')
	expect(html).toContain('<h6>Deep heading</h6>')
	expect(html).toContain('<strong>bold</strong>')
	expect(html).toContain('<em>italic</em>')
	expect(html).toContain('<del>gone</del>')
	expect(html).toContain('<code>inline code</code>')
	expect(html).toContain('<blockquote>')
	expect(html).toContain('<li><span>first</span></li>')
	expect(html).toContain('<input type="checkbox" disabled="" checked=""/>')
	expect(html).toContain('start="5"')
	expect(html).toContain('>Name</th>')
	expect(html).toContain('>a</td>')
	expect(html).toContain('data-markdown-table')
	expect(html).toContain('data-markdown-table-compact-last')
	expect(html).toContain('class="shiki')
	expect(html).toContain('const')
	expect(html).toContain('<hr')
	// Character references decode to text, then re-escape safely on output.
	expect(html).toContain('Entities: &amp; A stay characters.')
})

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

test('first-party render options keep authored heading levels and drop the ugc rel', async () => {
	const markdown = [
		'# Top',
		'',
		'## Section',
		'',
		'###### Deep',
		'',
		'[docs](https://example.com/docs)',
	].join('\n')

	const firstParty = await renderToString(
		jsx('div', {
			children: renderMarkdownNodes(markdown, {
				headingOffset: 0,
				linkRel: 'noopener noreferrer',
			}),
		}),
	)
	// h1 stays page-owned even at offset 0; deep headings clamp at h6.
	expect(firstParty).toContain('<h2>Top</h2>')
	expect(firstParty).toContain('<h2>Section</h2>')
	expect(firstParty).toContain('<h6>Deep</h6>')
	expect(firstParty).toContain(
		'<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">docs</a>',
	)

	// The default (third-party README) policy is unchanged.
	const thirdParty = await renderToString(
		jsx('div', { children: renderMarkdownNodes(markdown) }),
	)
	expect(thirdParty).toContain('<h3>Top</h3>')
	expect(thirdParty).toContain('<h4>Section</h4>')
	expect(thirdParty).toContain('rel="noopener noreferrer nofollow ugc"')
})

test('first-party headingIds emit unique ids, token-derived accessible names, and sibling permalinks', async () => {
	const renderWithIds = (markdown: string) =>
		renderToString(
			jsx('div', {
				children: renderMarkdownNodes(markdown, {
					headingOffset: 0,
					headingIds: true,
				}),
			}),
		)
	const permalinkFor = (html: string, id: string) =>
		html.match(new RegExp(`<a href="#${id}"[^>]*>[\\s\\S]*?</a>`))?.[0]

	const html = await renderWithIds(
		[
			'## Josh Tomaino',
			'',
			'## Josh Tomaino',
			'',
			'## Jett Hays',
			'',
			'## Gabriel Alegría',
			'',
			'## **Install** `CLI`',
			'',
			'## Read [the guide](https://example.com/guide(nested)/path)',
			'',
			'## Heading with ![logo](https://img.example/logo.png) icon',
		].join('\n'),
	)
	for (const part of [
		'<h2 id="josh-tomaino" aria-label="Josh Tomaino">',
		'href="#josh-tomaino"',
		'data-heading-permalink=""',
		'data-heading-anchor=""',
		'<span data-heading-text="">Josh Tomaino</span>',
		'<h2 id="josh-tomaino-2" aria-label="Josh Tomaino">',
		'href="#josh-tomaino-2"',
		'<h2 id="jett-hays" aria-label="Jett Hays">',
		'<h2 id="gabriel-alegria" aria-label="Gabriel Alegría">',
		// Accessible names come from parsed inline tokens, not markdown source.
		'aria-label="Install CLI"',
		'aria-label="Read the guide"',
		'aria-label="Heading with logo icon"',
	]) {
		expect(html).toContain(part)
	}
	expect(html).not.toContain('aria-label="**Install**')
	expect(html).not.toContain('aria-label="Read [the guide]')
	expect(html).not.toContain('aria-label="Heading with ![logo]')
	for (const [id, name] of [
		['josh-tomaino', 'Josh Tomaino'],
		['install-cli', 'Install CLI'],
	] as const) {
		const permalink = permalinkFor(html, id)
		expect(permalink).toContain('aria-label="Link to this section"')
		expect(permalink).not.toContain(`aria-label="${name}"`)
	}

	// Permalinks stay beside inline heading links instead of wrapping them.
	const linkedId = 'read-the-guide-https-example.com-guide'
	const linked = await renderWithIds(
		'## Read [the guide](https://example.com/guide)',
	)
	expect(linked).toContain(`id="${linkedId}" aria-label="Read the guide"`)
	expect(linked).toContain(`href="#${linkedId}"`)
	expect(linked).toContain('href="https://example.com/guide"')
	const permalink = permalinkFor(linked, linkedId)
	expect(permalink).toContain('aria-label="Link to this section"')
	expect(permalink).not.toContain('aria-label="Read the guide"')
	expect(permalink?.match(/<a /g)).toHaveLength(1)
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

test('markdown tables keep last-column nowrap only when every last cell is a short label', async () => {
	const compact = await renderMarkdown(
		[
			'| You want to | Use |',
			'| --- | --- |',
			'| Keep working code | A **package** |',
			'| Sign in so code can act as you | An **integration** |',
		].join('\n'),
	)
	expect(compact).toContain('data-markdown-table-compact-last')

	const descriptive = await renderMarkdown(
		[
			'| File | Topic |',
			'| --- | --- |',
			'| oauth.md | Start here for third-party OAuth redirect URI and params |',
		].join('\n'),
	)
	expect(descriptive).toContain('data-markdown-table=""')
	expect(descriptive).not.toContain('data-markdown-table-compact-last=""')
})
