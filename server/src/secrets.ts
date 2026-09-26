// Secrets for relay nodes come from Secret Manager rather than files or metadata, so the
// image and the instance template hold none. For each NAME_SECRET=<secret id> in the
// environment, loadSecrets sets NAME to that secret's latest version, read with the VM
// service account's token.

import { metadataAccessToken } from "./firestore.ts";

export async function loadSecrets(
  env: NodeJS.ProcessEnv,
  projectId: string,
  accessToken: () => Promise<string> = metadataAccessToken(),
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  const loaded: string[] = [];
  for (const [key, secretId] of Object.entries(env)) {
    if (!key.endsWith("_SECRET") || !secretId) continue;
    const name = key.slice(0, -"_SECRET".length);
    const res = await fetchFn(
      `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${encodeURIComponent(secretId)}/versions/latest:access`,
      { headers: { authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(10_000) },
    );
    // The error body names the secret, never its value.
    if (!res.ok) throw new Error(`secret ${secretId} for ${name}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const { payload } = (await res.json()) as { payload: { data: string } };
    env[name] = Buffer.from(payload.data, "base64").toString("utf8");
    loaded.push(name);
  }
  return loaded;
}
