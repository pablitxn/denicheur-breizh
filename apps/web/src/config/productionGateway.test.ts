import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(process.cwd(), "../..");
const dockerfile = readFileSync(resolve(repositoryRoot, "Dockerfile.web"), "utf8");
const nginx = readFileSync(resolve(process.cwd(), "runtime/nginx.conf"), "utf8");
const entrypoint = readFileSync(resolve(process.cwd(), "runtime/start-web.sh"), "utf8");

describe("production web gateway", () => {
  it("builds only a same-origin /api production bundle and never accepts a token build argument", () => {
    expect(dockerfile).toContain('test "${VITE_API_BASE_URL}" = "/api"');
    expect(dockerfile).not.toMatch(/VITE_(?:OPERATOR_)?TOKEN/);
    expect(dockerfile).not.toMatch(/(?:ARG|ENV)\s+(?:WEB_)?OPERATOR_TOKEN=/);
    expect(dockerfile).not.toMatch(/(?:ARG|ENV)\s+WEB_GATEWAY_AUTH_TOKEN=/);
  });

  it("requires a separate trusted-ingress identity before injecting the server-side API identity", () => {
    expect(nginx).toContain("include /tmp/denicheur/gateway-auth-runtime.conf;");
    expect(nginx).toContain("if ($denicheur_gateway_access_denied)");
    expect(nginx).toContain("location ^~ /api/");
    expect(nginx).toContain("include /tmp/denicheur/proxy-runtime.conf;");
    expect(nginx).toContain('proxy_set_header Proxy-Authorization "";');
    expect(nginx).toContain('proxy_set_header Origin "";');
    expect(nginx).toContain('proxy_set_header Cookie "";');
    expect(nginx).toContain('proxy_set_header Forwarded "";');
    expect(nginx).toContain('proxy_set_header X-Denicheur-Ingress-Token "";');
    expect(nginx).toContain("proxy_hide_header Authorization;");
    expect(entrypoint).toContain('proxy_set_header Authorization "Bearer %s";');
    expect(entrypoint).toContain("WEB_GATEWAY_AUTH_TOKEN_FILE is required.");
    expect(entrypoint).toContain("$http_x_denicheur_ingress_token");
    expect(entrypoint).toContain("~^/healthz$ 1;");
    expect(entrypoint).toContain("~^%s$ 1;");
  });

  it("requires a mounted token file and validates HTTPS upstream certificates", () => {
    expect(entrypoint).toContain("WEB_OPERATOR_TOKEN_FILE is required.");
    expect(entrypoint).toContain("gateway auth token must be different from the operator token");
    expect(entrypoint).not.toMatch(/WEB_OPERATOR_TOKEN:-/);
    expect(entrypoint).toContain("proxy_ssl_verify on;");
    expect(entrypoint).toContain("WEB_API_CA_FILE must be a readable CA bundle");
  });

  it("keeps credentials, query strings and referrers out of access logs", () => {
    expect(nginx).toContain('"$request_method $uri $server_protocol"');
    expect(nginx).not.toContain("$request_uri");
    expect(nginx).not.toContain("$http_authorization");
    expect(nginx).not.toContain("$http_referer");
  });
});
