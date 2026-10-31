# 0009: Shiki for in-app syntax highlighting

- **Status:** superseded, the app now uses TanStack Highlight with a selective
  language registry in `kody-highlight`, and TanStack Markdown for parsing.
  Serializable spans, escaped JSX, and light/dark themes stay in place.
- **Date:** 2026-08-06

## Context

Guides, blog posts, community READMEs, onboarding MCP snippets, and a few
account JSON dumps rendered code as unstyled `<pre><code>`. The app is a
Cloudflare Worker with Remix 3 SSR + client hydration, a strict first-party CSP
(`script-src 'self'`), and a markdown safety model that never uses marked's HTML
renderer or `innerHTML`. Highlighting has to stay Worker-safe, theme-aware
(`prefers-color-scheme`), and escape-safe for untrusted README fences.

## Decision

Use [Shiki](https://shiki.style/) with a fine-grained sync highlighter:
`createHighlighterCoreSync`, the JavaScript regex engine (no Oniguruma WASM), an
explicit language list, and GitHub light/dark dual themes. JavaScript / JSX
fences alias onto the TypeScript / TSX grammars so we do not ship a second
near-identical grammar pair. Render tokens as JSX text plus inline styles.
Unknown languages and oversized snippets fall back to escaped plaintext in the
same wrapper.

## Consequences

Highlighting quality matches VS Code grammars and follows the site theme without
client JS. The Worker and lazy client chunks pay for the bundled grammars;
adding a language is an explicit import. The browser loads those grammars only
through a dynamic `syntax-highlight-core` chunk, preloaded on code-bearing route
areas (account, blog/guides, community, onboarding) — not on the marketing
entry. WASM-based Oniguruma stays out of this path. Revisit if bundle size
becomes a problem or if a future Shiki Workers preset is smaller for the same
language set.
