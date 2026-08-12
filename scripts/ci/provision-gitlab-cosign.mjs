#!/usr/bin/env node

import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const EXPECTED_FILES = Object.freeze({
  privateKey: "cosign.key",
  publicKey: "cosign.pub",
  password: "password",
});
const SIGNING_ENVIRONMENT = "cosign-signing";
const MAINTAINER_ACCESS_LEVEL = 40;

function fail(message) {
  throw new Error(`Cosign provisioning: ${message}`);
}

function parseArguments(argv) {
  const options = {
    hostname: "gitlab.orchid-labs.xyz",
    project: "research-and-development/denicheur-breizh",
    glabBin: "glab",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--repair-password-hidden") {
      options.repairPasswordHidden = true;
      continue;
    }
    if (argument === "--material-dir") options.materialDirectory = value;
    else if (argument === "--hostname") options.hostname = value;
    else if (argument === "--project") options.project = value;
    else if (argument === "--glab-bin") options.glabBin = value;
    else if (argument === "--help") {
      console.log(
        "Usage: node scripts/ci/provision-gitlab-cosign.mjs --material-dir DIR " +
        "[--hostname HOST] [--project GROUP/PROJECT] [--repair-password-hidden]",
      );
      process.exit(0);
    } else {
      fail(`unknown or incomplete argument ${argument ?? "<missing>"}`);
    }
    index += 1;
  }

  if (!options.materialDirectory && !options.repairPasswordHidden) {
    fail("--material-dir is required unless --repair-password-hidden is used");
  }
  if (!/^[a-zA-Z0-9.-]+$/.test(options.hostname)) fail("hostname is invalid");
  if (!/^[a-zA-Z0-9._/-]+$/.test(options.project) || !options.project.includes("/")) {
    fail("project must be a GitLab namespace/project path");
  }
  if (!options.glabBin) fail("glab binary is invalid");
  return options;
}

function readRegularFile(path, { secret = false, maximumBytes = 1024 * 1024 } = {}) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${basename(path)} must be a regular file and not a symbolic link`);
  }
  if (metadata.size < 1 || metadata.size > maximumBytes) {
    fail(`${basename(path)} has an invalid size`);
  }
  if (secret && (metadata.mode & 0o077) !== 0) {
    fail(`${basename(path)} must not be readable or writable by group or others`);
  }
  return readFileSync(path, "utf8");
}

function validatePem(value, name, header, footer) {
  const lines = value.replace(/\r\n/g, "\n").trimEnd().split("\n");
  if (lines[0] !== header || lines.at(-1) !== footer || lines.length < 3) {
    fail(`${name} has an unexpected PEM envelope`);
  }
}

function validatePassword(password) {
  if (password.length < 16 || /\s/.test(password)) {
    fail("password must be a single line of at least 16 non-whitespace characters");
  }
}

function loadSigningMaterial(materialDirectory) {
  const directory = resolve(materialDirectory);
  const directoryMetadata = lstatSync(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    fail("material directory must be a directory and not a symbolic link");
  }

  const privateKey = readRegularFile(join(directory, EXPECTED_FILES.privateKey), {
    secret: true,
  });
  const publicKey = readRegularFile(join(directory, EXPECTED_FILES.publicKey));
  const password = readRegularFile(join(directory, EXPECTED_FILES.password), {
    secret: true,
    maximumBytes: 4096,
  });

  validatePem(
    privateKey,
    EXPECTED_FILES.privateKey,
    "-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----",
    "-----END ENCRYPTED SIGSTORE PRIVATE KEY-----",
  );
  validatePem(
    publicKey,
    EXPECTED_FILES.publicKey,
    "-----BEGIN PUBLIC KEY-----",
    "-----END PUBLIC KEY-----",
  );
  validatePassword(password);

  return { privateKey, publicKey, password };
}

function sanitizedEnvironment() {
  const environment = { ...process.env };
  for (const name of [
    "DEBUG",
    "GLAB_DEBUG",
    "GLAB_DEBUG_HTTP",
    "GIT_TRACE",
    "GIT_TRACE_CURL",
    "GIT_CURL_VERBOSE",
  ]) {
    delete environment[name];
  }
  return environment;
}

function parseHttpStatus(stderr) {
  const match = stderr.match(/HTTP\s+(\d{3})/i);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function createGitLabClient({ glabBin, hostname, project, payloadDirectory }) {
  const projectEndpoint = `projects/${encodeURIComponent(project)}`;
  let payloadSequence = 0;

  const request = ({ method = "GET", endpoint = projectEndpoint, payload, allowHttp = [] }) => {
    let payloadPath;
    const argumentsList = ["api", "--hostname", hostname, "--method", method, endpoint];
    try {
      if (payload !== undefined) {
        payloadSequence += 1;
        payloadPath = join(payloadDirectory, `payload-${payloadSequence}.json`);
        writeFileSync(payloadPath, `${JSON.stringify(payload)}\n`, {
          mode: 0o600,
          flag: "wx",
        });
        chmodSync(payloadPath, 0o600);
        // Older self-hosted GitLab releases reject glab's raw-file default as
        // an unsupported media type unless JSON is declared explicitly.
        argumentsList.push("--header", "Content-Type: application/json", "--input", payloadPath);
      }

      const result = spawnSync(glabBin, argumentsList, {
        encoding: "utf8",
        env: sanitizedEnvironment(),
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (result.error) fail(`unable to execute glab (${result.error.code ?? "spawn error"})`);
      if (result.status !== 0) {
        const httpStatus = parseHttpStatus(result.stderr ?? "");
        if (httpStatus !== undefined && allowHttp.includes(httpStatus)) {
          return { ok: false, httpStatus };
        }
        fail(`GitLab API ${method} ${endpoint} failed${httpStatus ? ` (HTTP ${httpStatus})` : ""}`);
      }
      return { ok: true, body: result.stdout ?? "" };
    } finally {
      if (payloadPath) {
        try {
          unlinkSync(payloadPath);
        } catch {
          // The outer secure-directory cleanup remains the final safety net.
        }
      }
    }
  };

  return { projectEndpoint, request };
}

function parseJson(response, label) {
  try {
    return JSON.parse(response.body || "null");
  } catch {
    fail(`GitLab returned invalid JSON for ${label}`);
  }
}

function provision(options, material) {
  const payloadDirectory = mkdtempSync(join(tmpdir(), "denicheur-cosign-provision-"));
  chmodSync(payloadDirectory, 0o700);
  const cleanup = () => rmSync(payloadDirectory, { recursive: true, force: true });
  const terminate = (exitCode) => {
    cleanup();
    process.exit(exitCode);
  };
  process.once("SIGINT", () => terminate(130));
  process.once("SIGTERM", () => terminate(143));

  const createdVariables = [];
  let environmentCreated = false;
  let protectedEnvironmentCreated = false;
  const client = createGitLabClient({ ...options, payloadDirectory });

  const rollback = () => {
    for (const variable of createdVariables.reverse()) {
      client.request({
        method: "DELETE",
        endpoint:
          `${client.projectEndpoint}/variables/${encodeURIComponent(variable.key)}` +
          `?filter%5Benvironment_scope%5D=${encodeURIComponent(variable.environmentScope)}`,
      });
    }
    if (protectedEnvironmentCreated) {
      client.request({
        method: "DELETE",
        endpoint: `${client.projectEndpoint}/protected_environments/${SIGNING_ENVIRONMENT}`,
        allowHttp: [404, 405, 415],
      });
    }
    if (environmentCreated) {
      const environments = parseJson(
        client.request({
          endpoint: `${client.projectEndpoint}/environments?name=${SIGNING_ENVIRONMENT}`,
        }),
        "environment rollback",
      );
      const created = environments.find((candidate) => candidate.name === SIGNING_ENVIRONMENT);
      if (created?.id !== undefined) {
        client.request({
          method: "DELETE",
          endpoint: `${client.projectEndpoint}/environments/${created.id}`,
        });
      }
    }
  };

  try {
    const project = parseJson(client.request({}), "project preflight");
    if (project.path_with_namespace !== options.project) fail("GitLab project identity mismatch");

    const existingVariables = parseJson(
      client.request({ endpoint: `${client.projectEndpoint}/variables?per_page=100` }),
      "CI variable preflight",
    );
    if (options.repairPasswordHidden) {
      const expectedMetadata = [
        {
          key: "COSIGN_PUBLIC_KEY_FILE",
          environmentScope: "*",
          variableType: "file",
          masked: false,
        },
        {
          key: "COSIGN_PRIVATE_KEY_FILE",
          environmentScope: SIGNING_ENVIRONMENT,
          variableType: "file",
          masked: false,
        },
        {
          key: "COSIGN_PASSWORD",
          environmentScope: SIGNING_ENVIRONMENT,
          variableType: "env_var",
          masked: true,
        },
      ];
      const matched = new Map();
      for (const expected of expectedMetadata) {
        const candidates = existingVariables.filter(
          (variable) =>
            variable.key === expected.key &&
            variable.environment_scope === expected.environmentScope,
        );
        if (candidates.length !== 1) {
          fail(`expected exactly one ${expected.key}@${expected.environmentScope} variable`);
        }
        const variable = candidates[0];
        if (
          variable.variable_type !== expected.variableType ||
          variable.protected !== true ||
          variable.masked !== expected.masked ||
          variable.raw !== true
        ) {
          fail(`${expected.key}@${expected.environmentScope} metadata is not repair-safe`);
        }
        matched.set(expected.key, variable);
      }

      const passwordVariable = matched.get("COSIGN_PASSWORD");
      if (passwordVariable.hidden === true) {
        console.log("COSIGN_PASSWORD@cosign-signing is already masked and hidden.");
        return;
      }
      validatePassword(passwordVariable.value);
      const passwordEndpoint =
        `${client.projectEndpoint}/variables/COSIGN_PASSWORD` +
        `?filter%5Benvironment_scope%5D=${encodeURIComponent(SIGNING_ENVIRONMENT)}`;
      const originalPasswordPayload = {
        key: "COSIGN_PASSWORD",
        value: passwordVariable.value,
        variable_type: "env_var",
        protected: true,
        masked: true,
        raw: true,
        environment_scope: SIGNING_ENVIRONMENT,
        description: passwordVariable.description ?? "Cosign private-key decryption password",
      };
      const hiddenPasswordPayload = {
        ...originalPasswordPayload,
        masked_and_hidden: true,
      };

      client.request({ method: "DELETE", endpoint: passwordEndpoint });
      try {
        client.request({
          method: "POST",
          endpoint: `${client.projectEndpoint}/variables`,
          payload: hiddenPasswordPayload,
        });
        const verificationVariables = parseJson(
          client.request({ endpoint: `${client.projectEndpoint}/variables?per_page=100` }),
          "hidden password verification",
        );
        const verifiedPassword = verificationVariables.find(
          (variable) =>
            variable.key === "COSIGN_PASSWORD" &&
            variable.environment_scope === SIGNING_ENVIRONMENT,
        );
        if (
          verifiedPassword?.hidden !== true ||
          verifiedPassword.masked !== true ||
          verifiedPassword.protected !== true
        ) {
          fail("GitLab did not persist COSIGN_PASSWORD as masked and hidden");
        }
      } catch (repairError) {
        try {
          client.request({ method: "DELETE", endpoint: passwordEndpoint, allowHttp: [404] });
          client.request({
            method: "POST",
            endpoint: `${client.projectEndpoint}/variables`,
            payload: originalPasswordPayload,
          });
        } catch {
          fail("password visibility repair failed and rollback was incomplete");
        }
        throw repairError;
      }
      console.log("COSIGN_PASSWORD@cosign-signing is now masked, hidden, and protected.");
      return;
    }

    const requestedKeys = new Set([
      "COSIGN_PRIVATE_KEY_FILE",
      "COSIGN_PUBLIC_KEY_FILE",
      "COSIGN_PASSWORD",
    ]);
    const conflicts = existingVariables
      .filter((variable) => requestedKeys.has(variable.key))
      .map((variable) => `${variable.key}@${variable.environment_scope}`);
    if (conflicts.length > 0) {
      fail(`refusing to overwrite existing CI variables: ${conflicts.join(", ")}`);
    }

    const environments = parseJson(
      client.request({ endpoint: `${client.projectEndpoint}/environments?name=${SIGNING_ENVIRONMENT}` }),
      "environment preflight",
    );
    let environment = environments.find((candidate) => candidate.name === SIGNING_ENVIRONMENT);
    if (!environment) {
      environment = parseJson(
        client.request({
          method: "POST",
          endpoint: `${client.projectEndpoint}/environments`,
          payload: { name: SIGNING_ENVIRONMENT },
        }),
        "environment creation",
      );
      environmentCreated = true;
    }

    let protectedEnvironmentState = "existing";
    const existingProtection = client.request({
      endpoint: `${client.projectEndpoint}/protected_environments/${SIGNING_ENVIRONMENT}`,
      allowHttp: [404, 405, 415],
    });
    if (existingProtection.ok) {
      const protection = parseJson(existingProtection, "protected environment preflight");
      const hasMaintainerGate = protection.deploy_access_levels?.some(
        (level) => level.access_level >= MAINTAINER_ACCESS_LEVEL,
      );
      if (!hasMaintainerGate) {
        fail("existing protected environment does not grant Maintainer deployment access");
      }
    } else {
      const protection = client.request({
        method: "POST",
        endpoint: `${client.projectEndpoint}/protected_environments`,
        payload: {
          name: SIGNING_ENVIRONMENT,
          deploy_access_levels: [{ access_level: MAINTAINER_ACCESS_LEVEL }],
        },
        allowHttp: [404, 405, 415],
      });
      if (protection.ok) {
        protectedEnvironmentCreated = true;
        protectedEnvironmentState = "created with Maintainer access";
      } else {
        protectedEnvironmentState = "unavailable on this GitLab edition";
      }
    }

    const variables = [
      {
        key: "COSIGN_PUBLIC_KEY_FILE",
        value: material.publicKey,
        variable_type: "file",
        protected: true,
        raw: true,
        environment_scope: "*",
        description: "Cosign public verification key",
      },
      {
        key: "COSIGN_PRIVATE_KEY_FILE",
        value: material.privateKey,
        variable_type: "file",
        protected: true,
        raw: true,
        environment_scope: SIGNING_ENVIRONMENT,
        description: "Encrypted Cosign signing key",
      },
      {
        key: "COSIGN_PASSWORD",
        value: material.password,
        variable_type: "env_var",
        protected: true,
        masked: true,
        masked_and_hidden: true,
        raw: true,
        environment_scope: SIGNING_ENVIRONMENT,
        description: "Cosign private-key decryption password",
      },
    ];

    for (const variable of variables) {
      client.request({
        method: "POST",
        endpoint: `${client.projectEndpoint}/variables`,
        payload: variable,
      });
      createdVariables.push({
        key: variable.key,
        environmentScope: variable.environment_scope,
      });
    }

    console.log("GitLab Cosign provisioning completed without exposing material.");
    console.log(`Environment ${environment.name}: ${environmentCreated ? "created" : "existing"}.`);
    console.log(`Protected environment: ${protectedEnvironmentState}.`);
    console.log(
      "Variables created: COSIGN_PUBLIC_KEY_FILE@*, " +
      "COSIGN_PRIVATE_KEY_FILE@cosign-signing, COSIGN_PASSWORD@cosign-signing.",
    );
  } catch (error) {
    try {
      rollback();
    } catch {
      fail("provisioning failed and automatic rollback was incomplete; inspect variable names only");
    }
    throw error;
  } finally {
    cleanup();
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  const material = options.repairPasswordHidden
    ? undefined
    : loadSigningMaterial(options.materialDirectory);
  provision(options, material);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Cosign provisioning failed");
  process.exitCode = 1;
}
