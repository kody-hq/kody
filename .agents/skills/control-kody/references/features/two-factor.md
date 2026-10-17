# Two-factor auth

TOTP setup and the `/verify` challenge after password login.

## How to get there

`/account/two-factor` while signed in. Challenge: `/verify`.

## Drive it

```bash
npm run control-kody -- browse --origin <preview> --path /account/two-factor
```

The page uses native Start server functions for website reads and mutations. Use
supported MCP capabilities through `control-kody search` and
`control-kody execute` when fixture data is needed.

## Gotchas

- SSR can paint before hydration finishes. Exercise the form after hydration; a
  screenshot alone does not prove submission works.
