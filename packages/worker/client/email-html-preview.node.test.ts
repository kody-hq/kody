import { expect, test } from 'vitest'
import {
	buildAdminEmailHtmlPreviewDocument,
	emailHtmlPreviewSandbox,
	stripDangerousEmailHtml,
} from './email-html-preview.ts'

test('email HTML preview sanitizes scripts and wraps fragments in a safe document', () => {
	const dirty =
		'<p>Hello</p><script>alert("xss")</script><p>World</p><SCRIPT type="text/javascript">evil()</SCRIPT>'
	expect(stripDangerousEmailHtml(dirty)).toBe('<p>Hello</p><p>World</p>')

	const fragment = buildAdminEmailHtmlPreviewDocument(
		'<p>Invoice <strong>due</strong></p>',
	)
	expect(fragment).toMatch(/^<!DOCTYPE html>/i)
	expect(fragment).toContain('content="no-referrer"')
	expect(fragment).toContain('<base target="_blank">')
	expect(fragment).toContain('<p>Invoice <strong>due</strong></p>')

	const fullDocument = `<!DOCTYPE html>
<html>
<head><title>Newsletter</title></head>
<body><h1>Title</h1></body>
</html>`
	const preserved = buildAdminEmailHtmlPreviewDocument(fullDocument)
	expect(preserved).toContain('<title>Newsletter</title>')
	expect(preserved).toContain(
		'<!DOCTYPE html><meta name="referrer" content="no-referrer"><base target="_blank">\n<html>\n<head><title>',
	)
	expect(preserved).not.toMatch(/<html>[\s\S]*<html>/i)

	const scripted = `<html><head></head><body><script>bad()</script><p>ok</p></body></html>`
	const sanitized = buildAdminEmailHtmlPreviewDocument(scripted)
	expect(sanitized).toContain('<p>ok</p>')
	expect(sanitized).not.toMatch(/<script/i)
})

test('email HTML preview opens every link in a new tab without an opener', () => {
	const doc = buildAdminEmailHtmlPreviewDocument(
		`<a href="https://a.example" target="_self">a</a>
<a href="https://b.example" target='inbox' rel="opener">b</a>
<A HREF="https://c.example" TARGET=_top REL=opener>c</A>
<map><area href="https://d.example" target="_parent" rel="opener"></map>
<a href="https://e.example" data-rel="keep" title="ok">e</a>`,
	)
	const body = doc.slice(doc.indexOf('<body>'))
	expect(body).not.toMatch(/\starget\s*=/i)
	expect(body).not.toMatch(/\srel\s*=/i)
	expect(doc).toContain('<a href="https://a.example">a</a>')
	expect(doc).toContain('<A HREF="https://c.example">c</A>')
	expect(doc).toContain('<area href="https://d.example">')
	expect(doc).toContain(
		'<a href="https://e.example" data-rel="keep" title="ok">e</a>',
	)
	expect(doc.indexOf('<base target="_blank">')).toBeLessThan(
		doc.indexOf('<a href'),
	)
})

test('email HTML preview reads link attributes like the HTML tokenizer', () => {
	const doc = buildAdminEmailHtmlPreviewDocument(
		`<a href="https://x.example/?q=a>b" target="_self" rel="opener">x</a>
<a title='1 > 0 target=keep' target=_top rel=opener>y</a>
<a target="_self"href="https://z.example">z</a>
<a href=https://w.example/a>b target=_top>w</a>
<abbr target="keep">abbr</abbr>`,
	)
	const body = doc.slice(doc.indexOf('<body>'))
	expect(body).toContain('<a href="https://x.example/?q=a>b">x</a>')
	expect(body).toContain("<a title='1 > 0 target=keep'>y</a>")
	expect(body).toContain('<a href="https://z.example">z</a>')
	// Unquoted values end at `>`, so the rest is text, not attributes.
	expect(body).toContain('<a href=https://w.example/a>b target=_top>w</a>')
	expect(body).toContain('<abbr target="keep">abbr</abbr>')
})

test('email HTML preview puts its head tags at the start of the document', () => {
	const head =
		'<meta name="referrer" content="no-referrer"><base target="_blank">'
	const htmlOnly = buildAdminEmailHtmlPreviewDocument(
		'<html lang="en"><body><a href="https://x.example">x</a></body></html>',
	)
	expect(htmlOnly.startsWith(`${head}<html lang="en"><body>`)).toBe(true)

	const doctypeOnly = buildAdminEmailHtmlPreviewDocument(
		'<!DOCTYPE html><body>x</body>',
	)
	expect(doctypeOnly.startsWith(`<!DOCTYPE html>${head}<body>`)).toBe(true)

	// A head lookalike in a comment or attribute must not capture the tags.
	const decoy = buildAdminEmailHtmlPreviewDocument(
		'<!DOCTYPE html><!-- <head> --><html><head data-x="<head>"><title>t</title></head><body>x</body></html>',
	)
	expect(decoy.startsWith(`<!DOCTYPE html>${head}<!-- <head> -->`)).toBe(true)
	expect(decoy.split(head)).toHaveLength(2)
})

test('email HTML preview sandbox allows only popups that escape the sandbox', () => {
	const tokens = emailHtmlPreviewSandbox.split(/\s+/)
	expect(tokens.sort()).toEqual([
		'allow-popups',
		'allow-popups-to-escape-sandbox',
	])
})
