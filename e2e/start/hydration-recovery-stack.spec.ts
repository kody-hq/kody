import { test, expect } from "@playwright/test";
import { buildSync } from "esbuild";

test("extra server children report the affected host and component", async ({
  page,
}) => {
  await page.setContent(
    '<div id="fixture"><section><span>ready</span><i>unexpected</i></section></div>',
  );
  const client = buildSync({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
import {createElement as h} from '@tanstack/redact';
import {hydrateRoot} from '@tanstack/redact/dom-client';
window.fixtureRecoveries=[];
function ProfileFixture(){return h('section',null,h('span',null,'ready'))}
hydrateRoot(document.getElementById('fixture'),h(ProfileFixture),{
 onRecoverableError:(error,info)=>window.fixtureRecoveries.push({message:error.message,stack:info.componentStack}),
});
`,
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  }).outputFiles[0]!.text;
  await page.addScriptTag({ content: client });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { fixtureRecoveries: { stack: string }[] })
            .fixtureRecoveries,
      ),
    )
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stack: expect.stringContaining(
            "\n    at section\n    at ProfileFixture",
          ),
        }),
      ]),
    );
  await expect(page.locator("#fixture")).toHaveText("ready");
});
