// Cloudflare REST helpers for the Wasm probe: upload, workers.dev, delete with
// retries, sweep, and GraphQL analytics. Plain fetch, no dependencies.
const api = "https://api.cloudflare.com/client/v4";
export const probePrefix = "kody-wasm-probe-";

export function cloudflare({ token, accountId }) {
  async function request(pathname, init = {}) {
    const response = await fetch(`${api}${pathname}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return {
      status: response.status,
      ok: response.ok && json?.success !== false,
      json,
      text,
    };
  }
  const account = `/accounts/${accountId}`;
  return {
    request,
    async verifyToken() {
      const accountVerify = await request(`${account}/tokens/verify`);
      if (accountVerify.ok)
        return { kind: "account", status: accountVerify.json.result?.status };
      const userVerify = await request("/user/tokens/verify");
      if (userVerify.ok)
        return { kind: "user", status: userVerify.json.result?.status };
      return {
        kind: "unknown",
        status: `${accountVerify.status}/${userVerify.status}`,
      };
    },
    async subdomain() {
      const result = await request(`${account}/workers/subdomain`);
      if (!result.ok)
        throw new Error(
          `workers subdomain read failed: HTTP ${result.status} ${summarizeErrors(result)}`,
        );
      return result.json.result.subdomain;
    },
    async upload({ name, mainModule, modules, compatibilityDate, bindings }) {
      const form = new FormData();
      form.set(
        "metadata",
        new Blob(
          [
            JSON.stringify({
              main_module: mainModule,
              compatibility_date: compatibilityDate,
              bindings,
            }),
          ],
          {
            type: "application/json",
          },
        ),
      );
      for (const [fileName, source] of Object.entries(modules)) {
        form.set(
          fileName,
          new Blob([source], { type: "application/javascript+module" }),
          fileName,
        );
      }
      const result = await request(`${account}/workers/scripts/${name}`, {
        method: "PUT",
        body: form,
      });
      if (!result.ok)
        throw new Error(
          `upload ${name} failed: HTTP ${result.status} ${summarizeErrors(result)}`,
        );
      const enable = await request(
        `${account}/workers/scripts/${name}/subdomain`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true, previews_enabled: false }),
        },
      );
      if (!enable.ok)
        throw new Error(
          `workers.dev enable for ${name} failed: HTTP ${enable.status} ${summarizeErrors(enable)}`,
        );
    },
    async listScripts() {
      const result = await request(`${account}/workers/scripts`);
      if (!result.ok)
        throw new Error(
          `list scripts failed: HTTP ${result.status} ${summarizeErrors(result)}`,
        );
      return result.json.result.map((script) => ({
        name: script.id,
        createdOn: script.created_on,
        modifiedOn: script.modified_on,
      }));
    },
    async deleteScript(name, { attempts = 6, baseDelayMs = 2000 } = {}) {
      if (!name.startsWith(probePrefix))
        throw new Error(`refusing to delete non-probe Worker ${name}`);
      const log = [];
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const result = await request(
          `${account}/workers/scripts/${name}?force=true`,
          { method: "DELETE" },
        );
        log.push(`attempt ${attempt}: HTTP ${result.status}`);
        if (result.ok || result.status === 404)
          return { deleted: true, attempts: attempt, log };
        if (attempt < attempts)
          await new Promise((r) =>
            setTimeout(r, baseDelayMs * 2 ** (attempt - 1)),
          );
      }
      return { deleted: false, attempts, log };
    },
    async graphql(query, variables) {
      const result = await request("/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      return {
        status: result.status,
        data: result.json?.data ?? null,
        errors: result.json?.errors ?? null,
        raw: result.json ? null : result.text.slice(0, 300),
      };
    },
  };
}

export function summarizeErrors(result) {
  const errors = result.json?.errors;
  if (Array.isArray(errors) && errors.length)
    return errors
      .map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim())
      .join("; ");
  return result.text.slice(0, 200);
}

/** Deletes probe Workers: all of them, or those older than `olderThanMs`, never `keep`. */
export async function sweepProbeWorkers(
  cf,
  { olderThanMs = null, keep = [] } = {},
) {
  const scripts = await cf.listScripts();
  const now = Date.now();
  const report = [];
  for (const script of scripts) {
    if (!script.name.startsWith(probePrefix) || keep.includes(script.name))
      continue;
    const age = now - Date.parse(script.createdOn);
    if (olderThanMs !== null && age < olderThanMs) {
      report.push({
        name: script.name,
        action: "kept (younger than sweep age)",
      });
      continue;
    }
    const result = await cf.deleteScript(script.name);
    report.push({
      name: script.name,
      action: result.deleted
        ? `deleted (${result.attempts} attempt(s))`
        : `DELETE FAILED: ${result.log.join(", ")}`,
    });
  }
  return report;
}
