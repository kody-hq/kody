# Passkeys

WebAuthn registration and authentication.

## How to get there

`/account/passkeys`. Browser-gated; Cloud Agent VMs often lack a platform
authenticator.

## Drive it

```bash
npm run control-kody -- browse --origin <preview> --path /account/passkeys
```

The page uses native Start server functions for website reads and mutations. Use
supported MCP capabilities through `control-kody search` and
`control-kody execute` when fixture data is needed.

Registration and authentication use native server functions from the browser. A
supported authenticator is required to verify a complete WebAuthn ceremony.
