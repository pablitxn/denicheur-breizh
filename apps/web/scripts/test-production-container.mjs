import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const image = process.env.WEB_GATEWAY_TEST_IMAGE?.trim() || "denicheur-breizh-web:gateway-test";
const nodeImage = "node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03";
const testToken = "container-test-token-000000000000000000000000";
const gatewayTestToken = "Gateway-Test-Token_000000000000000000000000";
const temporaryDirectory = mkdtempSync(join(tmpdir(), "denicheur-web-gateway-"));
const tokenPath = join(temporaryDirectory, "operator-token");
const gatewayTokenPath = join(temporaryDirectory, "gateway-token");
writeFileSync(tokenPath, `${testToken}\n`, { mode: 0o644 });
writeFileSync(gatewayTokenPath, `${gatewayTestToken}\n`, { mode: 0o644 });
process.on("exit", () => rmSync(temporaryDirectory, { recursive: true, force: true }));

function docker(args, expectedStatus = 0) {
  const result = spawnSync("docker", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== expectedStatus) {
    throw new Error([
      `docker ${args.join(" ")} exited ${result.status}; expected ${expectedStatus}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
  return result;
}

if (!process.argv.includes("--reuse-image")) {
  const build = docker(["build", "--file", "Dockerfile.web", "--tag", image, "."]);
  process.stdout.write(build.stdout);
}

const missingUpstream = docker(["run", "--rm", image, "--check"], 1);
if (!missingUpstream.stderr.includes("WEB_API_UPSTREAM is required")) {
  throw new Error(`missing-upstream check failed closed for the wrong reason:\n${missingUpstream.stderr}`);
}

const operatorRun = [
  "run", "--rm",
  "--volume", `${tokenPath}:/run/secrets/operator-token:ro`,
  "--env", "WEB_OPERATOR_TOKEN_FILE=/run/secrets/operator-token",
];
const invalidUpstream = docker([...operatorRun, "--env", "WEB_API_UPSTREAM=http://api:70000", image, "--check"], 1);
if (!invalidUpstream.stderr.includes("port must be between 1 and 65535")) {
  throw new Error(`invalid-upstream check failed closed for the wrong reason:\n${invalidUpstream.stderr}`);
}

const missingGatewayToken = docker([
  ...operatorRun,
  "--env", "WEB_API_UPSTREAM=http://127.0.0.1:4310",
  image, "--check",
], 1);
if (!missingGatewayToken.stderr.includes("WEB_GATEWAY_AUTH_TOKEN_FILE is required")) {
  throw new Error(`missing-gateway-token check failed closed for the wrong reason:\n${missingGatewayToken.stderr}`);
}

const commonRun = [
  ...operatorRun,
  "--volume", `${gatewayTokenPath}:/run/secrets/gateway-token:ro`,
  "--env", "WEB_GATEWAY_AUTH_TOKEN_FILE=/run/secrets/gateway-token",
];

const reusedServiceToken = docker([
  ...operatorRun,
  "--env", "WEB_GATEWAY_AUTH_TOKEN_FILE=/run/secrets/operator-token",
  "--env", "WEB_API_UPSTREAM=http://127.0.0.1:4310",
  image, "--check",
], 1);
if (!reusedServiceToken.stderr.includes("must be different from WEB_OPERATOR_TOKEN_FILE")) {
  throw new Error(`reused-service-token check failed closed for the wrong reason:\n${reusedServiceToken.stderr}`);
}

const valid = docker([...commonRun, "--env", "WEB_API_UPSTREAM=http://127.0.0.1:4310", image, "--check"]);
if (!valid.stderr.includes("test is successful")) {
  throw new Error(`nginx did not validate the rendered gateway config:\n${valid.stderr}`);
}
if ([testToken, gatewayTestToken].some((secret) => valid.stdout.includes(secret) || valid.stderr.includes(secret))) {
  throw new Error("the entrypoint exposed a runtime token in container output");
}

docker([
  "run", "--rm", "--entrypoint", "sh", image, "-eu", "-c",
  "! grep -R -F -e WEB_OPERATOR_TOKEN -e OPERATOR_TOKEN -e WEB_GATEWAY_AUTH_TOKEN -e http://127.0.0.1:4310 -e http://127.0.0.1:14310 /usr/share/nginx/html && grep -R -F -q /api /usr/share/nginx/html",
]);

const resourceSuffix = `${process.pid}-${Date.now()}`;
const network = `denicheur-web-gateway-${resourceSuffix}`;
const apiContainer = `denicheur-mock-api-${resourceSuffix}`;
const webContainer = `denicheur-web-${resourceSuffix}`;

const mockApiScript = `
  import http from "node:http";
  http.createServer((request, response) => {
    const result = {
      authorizationMatched: request.headers.authorization === "Bearer ${testToken}",
      browserHeadersStripped: !request.headers.origin && !request.headers.cookie && !request.headers.referer,
      ingressHeaderStripped: !request.headers["x-denicheur-ingress-token"],
      host: request.headers.host,
      path: request.url,
    };
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Authorization", "must-not-reach-browser");
    response.setHeader("Proxy-Authorization", "must-not-reach-browser");
    response.setHeader("Set-Cookie", "must-not-reach-browser=true");
    response.end(JSON.stringify(result));
  }).listen(4310, "0.0.0.0");
`;

const ingressProbeScript = `
  const endpoint = "http://${webContainer}:8080/api/v1/media/probe.webp";
  const unauthenticated = await fetch(endpoint);
  const forged = await fetch(endpoint, {
    headers: { "X-Denicheur-Ingress-Token": "not-the-ingress-token" },
  });
  const wrongCase = await fetch(endpoint, {
    headers: { "X-Denicheur-Ingress-Token": "${gatewayTestToken.toLowerCase()}" },
  });
  const staticWithoutIngress = await fetch("http://${webContainer}:8080/");
  const healthCaseBypass = await fetch("http://${webContainer}:8080/HEALTHZ");
  const health = await fetch("http://${webContainer}:8080/healthz");
  const response = await fetch(endpoint, {
    headers: {
      "X-Denicheur-Ingress-Token": "${gatewayTestToken}",
      Authorization: "Bearer browser-supplied-token-must-be-overwritten",
      Origin: "https://attacker.invalid",
      Referer: "https://attacker.invalid/form",
      Cookie: "session=must-be-stripped",
    },
  });
  const result = await response.json();
  const safe = response.status === 200
    && result.authorizationMatched === true
    && result.browserHeadersStripped === true
    && result.ingressHeaderStripped === true
    && result.host === "${apiContainer}:4310"
    && result.path === "/v1/media/probe.webp"
    && response.headers.get("cache-control") === "no-store"
    && !response.headers.has("authorization")
    && !response.headers.has("proxy-authorization")
    && !response.headers.has("set-cookie")
    && unauthenticated.status === 401
    && forged.status === 401
    && wrongCase.status === 401
    && staticWithoutIngress.status === 401
    && healthCaseBypass.status === 401
    && health.status === 200;
  if (!safe) {
    console.error(JSON.stringify({ status: response.status, result, headers: Object.fromEntries(response.headers) }));
    process.exit(1);
  }
`;

docker(["network", "create", network]);
try {
  docker([
    "run", "--detach", "--rm", "--name", apiContainer, "--network", network,
    nodeImage, "node", "--input-type=module", "--eval", mockApiScript,
  ]);
  docker([
    ...commonRun,
    "--detach", "--name", webContainer, "--network", network,
    "--env", `WEB_API_UPSTREAM=http://${apiContainer}:4310`, image,
  ]);

  await new Promise((resolve) => setTimeout(resolve, 250));
  docker([
    "run", "--rm", "--network", network,
      nodeImage, "node", "--input-type=module", "--eval", ingressProbeScript,
  ]);
} finally {
  spawnSync("docker", ["rm", "--force", webContainer, apiContainer], { cwd: repositoryRoot, stdio: "ignore" });
  spawnSync("docker", ["network", "rm", network], { cwd: repositoryRoot, stdio: "ignore" });
}

process.stdout.write("production gateway container checks passed\n");
