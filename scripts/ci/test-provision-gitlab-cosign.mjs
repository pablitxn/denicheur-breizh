import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const helper = join(repositoryRoot, "scripts/ci/provision-gitlab-cosign.mjs");
const privateKey = [
  "-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----",
  "fixture-private-key-body",
  "-----END ENCRYPTED SIGSTORE PRIVATE KEY-----",
  "",
].join("\n");
const publicKey = [
  "-----BEGIN PUBLIC KEY-----",
  "fixture-public-key-body",
  "-----END PUBLIC KEY-----",
  "",
].join("\n");
const password = "fixture-password-123456789";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function runScenario({
  protectedEnvironmentUnsupportedStatus,
  failKey,
  failStatus = 400,
  repairPasswordHidden = false,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "denicheur-cosign-helper-test-"));
  const materialDirectory = join(directory, "material");
  const fakeGlab = join(directory, "fake-glab.mjs");
  const logPath = join(directory, "requests.jsonl");
  const statePath = join(directory, "state");
  try {
    mkdirSync(materialDirectory, { mode: 0o700 });
    writeFileSync(join(materialDirectory, "cosign.key"), privateKey, { mode: 0o600 });
    writeFileSync(join(materialDirectory, "cosign.pub"), publicKey, { mode: 0o644 });
    writeFileSync(join(materialDirectory, "password"), password, { mode: 0o600 });
    writeFileSync(
      fakeGlab,
      `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const method = args[args.indexOf("--method") + 1];
const endpoint = args[args.indexOf("--method") + 2];
const inputIndex = args.indexOf("--input");
const inputPath = inputIndex >= 0 ? args[inputIndex + 1] : undefined;
const payload = inputPath ? JSON.parse(readFileSync(inputPath, "utf8")) : undefined;
appendFileSync(process.env.FAKE_GLAB_LOG, JSON.stringify({ args, method, endpoint, inputPath, payload }) + "\\n");
const project = "projects/research-and-development%2Fdenicheur-breizh";
if (method === "GET" && endpoint === project) console.log(JSON.stringify({ path_with_namespace: "research-and-development/denicheur-breizh" }));
else if (method === "GET" && endpoint.includes("/variables?") && process.env.FAKE_REPAIR === "1") console.log(JSON.stringify([
  { key: "COSIGN_PUBLIC_KEY_FILE", value: ${JSON.stringify(publicKey)}, variable_type: "file", protected: true, masked: false, hidden: false, raw: true, environment_scope: "*" },
  { key: "COSIGN_PRIVATE_KEY_FILE", value: ${JSON.stringify(privateKey)}, variable_type: "file", protected: true, masked: false, hidden: false, raw: true, environment_scope: "cosign-signing" },
  { key: "COSIGN_PASSWORD", value: ${JSON.stringify(password)}, variable_type: "env_var", protected: true, masked: true, hidden: existsSync(process.env.FAKE_GLAB_STATE), raw: true, environment_scope: "cosign-signing", description: "Cosign private-key decryption password" }
]));
else if (method === "GET" && endpoint.includes("/variables?")) console.log("[]");
else if (method === "GET" && endpoint.includes("/environments?")) console.log("[]");
else if (method === "POST" && endpoint.endsWith("/environments")) console.log(JSON.stringify({ id: 71, name: "cosign-signing" }));
else if (method === "GET" && endpoint.includes("/protected_environments/")) { console.error("glab: HTTP 404"); process.exit(1); }
else if (method === "POST" && endpoint.endsWith("/protected_environments") && process.env.FAKE_PROTECTED_STATUS) { console.error("glab: HTTP " + process.env.FAKE_PROTECTED_STATUS); process.exit(1); }
else if (method === "POST" && endpoint.endsWith("/protected_environments")) console.log(JSON.stringify({ name: "cosign-signing", deploy_access_levels: [{ access_level: 40 }] }));
else if (method === "POST" && endpoint.endsWith("/variables") && payload.key === process.env.FAKE_FAIL_KEY) { console.error("glab: HTTP " + process.env.FAKE_FAIL_STATUS); process.exit(1); }
else if (method === "POST" && endpoint.endsWith("/variables")) { if (process.env.FAKE_REPAIR === "1" && payload.key === "COSIGN_PASSWORD" && payload.masked_and_hidden === true) writeFileSync(process.env.FAKE_GLAB_STATE, "hidden"); console.log(JSON.stringify({ key: payload.key })); }
else if (method === "DELETE") console.log("{}");
else { console.error("glab: HTTP 500"); process.exit(1); }
`,
      { mode: 0o700 },
    );
    chmodSync(fakeGlab, 0o700);

    const helperArguments = [helper];
    if (repairPasswordHidden) helperArguments.push("--repair-password-hidden");
    else helperArguments.push("--material-dir", materialDirectory);
    helperArguments.push("--glab-bin", fakeGlab);
    const result = spawnSync(
      process.execPath,
      helperArguments,
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_GLAB_LOG: logPath,
          FAKE_PROTECTED_STATUS: protectedEnvironmentUnsupportedStatus ? String(protectedEnvironmentUnsupportedStatus) : "",
          FAKE_FAIL_KEY: failKey ?? "",
          FAKE_FAIL_STATUS: String(failStatus),
          FAKE_REPAIR: repairPasswordHidden ? "1" : "0",
          FAKE_GLAB_STATE: statePath,
          GLAB_DEBUG_HTTP: "1",
        },
      },
    );
    const output = `${result.stdout}${result.stderr}`;
    check(!output.includes(privateKey.trim()), "private key leaked to helper output");
    check(!output.includes(password), "password leaked to helper output");

    const requests = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    for (const request of requests) {
      const serializedArguments = JSON.stringify(request.args);
      check(!serializedArguments.includes(privateKey.trim()), "private key appeared in argv");
      check(!serializedArguments.includes(password), "password appeared in argv");
      if (request.inputPath) check(!existsSync(request.inputPath), "temporary API payload survived");
      if (request.payload) {
        const headerIndex = request.args.indexOf("--header");
        check(
          headerIndex >= 0 && request.args[headerIndex + 1] === "Content-Type: application/json",
          "JSON API payload did not declare its media type",
        );
      }
    }
    return { result, requests };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const successful = await runScenario();
check(successful.result.status === 0, "supported provisioning scenario failed");
const variablePayloads = successful.requests
  .filter((request) => request.method === "POST" && request.endpoint.endsWith("/variables"))
  .map((request) => request.payload);
check(variablePayloads.length === 3, "expected exactly three variable creations");
const byKey = Object.fromEntries(variablePayloads.map((variable) => [variable.key, variable]));
check(byKey.COSIGN_PRIVATE_KEY_FILE.variable_type === "file", "private key must be File type");
check(byKey.COSIGN_PRIVATE_KEY_FILE.protected === true, "private key must be protected");
check(byKey.COSIGN_PRIVATE_KEY_FILE.environment_scope === "cosign-signing", "private key scope mismatch");
check(
  byKey.COSIGN_PASSWORD.masked === true &&
    byKey.COSIGN_PASSWORD.masked_and_hidden === true &&
    byKey.COSIGN_PASSWORD.hidden === undefined,
  "password masked-and-hidden flags mismatch",
);
check(byKey.COSIGN_PASSWORD.environment_scope === "cosign-signing", "password scope mismatch");
check(byKey.COSIGN_PUBLIC_KEY_FILE.environment_scope === "*", "public key scope mismatch");
check(
  successful.requests.some(
    (request) => request.method === "POST" && request.endpoint.endsWith("/protected_environments") &&
      request.payload.deploy_access_levels[0].access_level === 40,
  ),
  "Maintainer protected-environment request missing",
);

for (const unsupportedStatus of [404, 415]) {
  const unsupported = await runScenario({
    protectedEnvironmentUnsupportedStatus: unsupportedStatus,
  });
  check(
    unsupported.result.status === 0,
    `protected-environment HTTP ${unsupportedStatus} fallback failed`,
  );
  check(
    unsupported.result.stdout.includes("unavailable on this GitLab edition"),
    `protected-environment HTTP ${unsupportedStatus} was not reported`,
  );
}

const rolledBack = await runScenario({ failKey: "COSIGN_PASSWORD" });
check(rolledBack.result.status !== 0, "variable creation failure did not fail closed");
const deletedVariables = rolledBack.requests
  .filter((request) => request.method === "DELETE" && request.endpoint.includes("/variables/"))
  .map((request) => request.endpoint);
check(deletedVariables.length === 2, "partial variables were not rolled back");

const variable415 = await runScenario({
  failKey: "COSIGN_PRIVATE_KEY_FILE",
  failStatus: 415,
});
check(variable415.result.status !== 0, "variable HTTP 415 was incorrectly tolerated");

const repaired = await runScenario({ repairPasswordHidden: true });
check(repaired.result.status === 0, "password hidden repair failed");
check(
  repaired.result.stdout.includes("now masked, hidden, and protected"),
  "password hidden repair was not reported",
);
const repairCreates = repaired.requests.filter(
  (request) => request.method === "POST" && request.endpoint.endsWith("/variables"),
);
check(repairCreates.length === 1, "password repair touched more than one variable");
check(repairCreates[0].payload.key === "COSIGN_PASSWORD", "password repair recreated the wrong variable");
check(repairCreates[0].payload.value === password, "password repair changed the secret value");
check(repairCreates[0].payload.masked_and_hidden === true, "password repair did not request hidden visibility");
check(
  repaired.requests.some(
    (request) =>
      request.method === "DELETE" &&
      request.endpoint.includes("/variables/COSIGN_PASSWORD?filter%5Benvironment_scope%5D=cosign-signing"),
  ),
  "password repair did not use the exact scoped delete",
);

console.log("GitLab Cosign provisioning fake-glab harness passed.");
