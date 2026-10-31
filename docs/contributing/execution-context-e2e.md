# Execution context e2e (preview)

`🖥️ Execution context e2e` (`.github/workflows/execution-context-e2e.yml`) runs
`kody daemon` for real on `ubuntu-latest`, `macos-latest`, `windows-latest`, and
`windows-11-arm` against a PR preview. It never touches production:
`tools/execution-context-e2e/run.ts` refuses any origin that is not a
`kody-*.workers.dev` preview.

Each cell:

1. Signs in as the public preview seed user and mints a short-lived CLI token
   with `mintCliToken` (`tools/preview-rehearsal/seed.ts`).
2. Registers a throwaway context (`e2e-<os>-<arch>-<run>`) with a passphrase key
   (`KODY_CONTEXT_KEY_PASSPHRASE`) in a temp home.
3. Allows a temp folder in the local policy and the server grant (rw), and turns
   host commands on locally (`kody context commands on`).
4. Starts `kody daemon` as an IPC child (`daemon-host.cjs`, the same stop path
   as the desktop app) and waits for `executionContextGet` to say `online`.
5. Runs `kody execute --context <name>` with a module that reads and writes the
   folder by its native path (`C:\...` on Windows) and runs one
   `kody.command.run` (PowerShell on Windows, `$SHELL` elsewhere).
6. Sends `stop`, then asserts no `workerd` (`workerd.exe`) process is left.
7. Revokes and deletes the context.

## Run it

The preview seed must have the experiment on: add the
`preview-flag:execution-contexts` label to the PR. 🔎 Preview then runs the
`execution_context_e2e` job (this workflow, called after the deploy job) on
every push. Previews sign session frames with the committed TEST key
(`ECP_FRAME_SIGNING_KEYS` in `packages/worker/.env.example`); without it daemons
never get a welcome frame. That key set is signed by the public test root
`root-test-1`, so `run.ts` sets `KODY_ECP_TRUST_TEST_ROOT=1` (TEST ONLY: the CLI
honors it only for https `*.workers.dev` and `localhost` API hosts, never
kody.codes; see [execution contexts](./architecture/execution-contexts.md)). To
rerun against a preview by hand:

```sh
gh workflow run execution-context-e2e.yml -f preview_name=kody-pr-<n> -f sha=<pr-head-sha>
```

The preview CLI token comes from `tools/preview-rehearsal/cli-token.ts`
(`cliCredentialBootstrap` through the MCP `api` tool, then the bootstrap
redeem), which stays importable from plain `node`.

Locally (any OS), against a preview:

```sh
npm run build --workspace @kodycodes/cli
PREVIEW_ORIGIN=https://<preview-app-origin> node tools/execution-context-e2e/run.ts
```
