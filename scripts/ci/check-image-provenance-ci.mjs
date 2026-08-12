import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
  KANIKO_BUILDER_IMAGE,
  createVerificationContext,
  createExpectedPredicate,
  validateImageEvidence,
} from "./verify-image-provenance.mjs";

const COSIGN_JOB_IMAGE =
  "cgr.dev/chainguard/cosign:latest-dev@sha256:41d066f46a66ce6292c343560e9688cc51e4330052f10d5d139cd1679b1dda7b";
const NODE_JOB_IMAGE =
  "node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03";
const CANONICAL_REGISTRY_HOST = "registry.orchid-labs.xyz:32443";
const REVIEWED_STAGES = ["validate", "build", "attest", "verify", "provenance"];
const REVIEWED_JOBS = new Map([
  ["check-workspace", "validate"],
  ["build-api-image", "build"],
  ["build-web-image", "build"],
  ["sign-image-provenance", "attest"],
  ["verify-image-cryptography", "verify"],
  ["verify-image-provenance", "provenance"],
]);
const PROMOTION_COMMAND =
  /\b(?:deploy|release|promote|promotion|production|rollout|publish)\b|\b(?:kubectl|helm|argocd|flux|nomad|ssh|scp|rsync)\b|\b(?:docker|podman|buildah)\s+push\b|\b(?:skopeo|crane|oras)\s+(?:copy|push)\b/i;

function policyFailure(message) {
  throw new Error(`CI image provenance policy: ${message}`);
}

function requireMatch(source, pattern, message) {
  if (!pattern.test(source)) policyFailure(message);
}

function requireAbsent(source, pattern, message) {
  if (pattern.test(source)) policyFailure(message);
}

function topLevelBlocks(source) {
  for (const line of source.split("\n")) {
    if (/^(?:\s|#|$)/.test(line)) continue;
    if (!/^[A-Za-z0-9_.-]+:/.test(line)) {
      policyFailure(`unsupported top-level YAML syntax: ${line.slice(0, 80)}`);
    }
  }
  const matches = [...source.matchAll(/^([A-Za-z0-9_.-]+):[^\n]*$/gm)];
  const blocks = new Map();
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const next = matches[index + 1];
    const name = current[1];
    if (blocks.has(name)) policyFailure(`duplicate top-level definition ${name}`);
    blocks.set(name, source.slice(current.index, next?.index ?? source.length));
  }
  return blocks;
}

function requiredBlock(blocks, name) {
  const block = blocks.get(name);
  if (!block) policyFailure(`missing ${name} job or template`);
  return block;
}

function declaredStages(blocks) {
  const stages = [...requiredBlock(blocks, "stages").matchAll(/^  -\s*([A-Za-z0-9_.-]+)\s*$/gm)]
    .map((match) => match[1]);
  if (stages.length === 0 || new Set(stages).size !== stages.length) {
    policyFailure("stages must be a non-empty list without duplicates");
  }
  return stages;
}

export function validateCiSupplyChain({
  ci,
  common,
  sign,
  cryptography,
  semantic,
  dockerApi,
  dockerWeb,
}) {
  const allSources = [ci, common, sign, cryptography, semantic].join("\n");
  const blocks = topLevelBlocks(ci);
  requireAbsent(
    ci,
    /^include:/m,
    "CI includes are forbidden until the policy harness can inspect their expanded jobs",
  );
  requireAbsent(
    allSources,
    /--(?:allow-insecure-registry|allow-http-registry|skip-tls-verify(?:-pull|-registry)?)(?:[=\s]|$)/,
    "registry TLS bypass flags are forbidden",
  );
  requireAbsent(
    allSources,
    /cosign\s+generate-key-pair|^-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----$[\s\S]+^-----END ENCRYPTED SIGSTORE PRIVATE KEY-----$/m,
    "the repository must never generate or embed a signing private key",
  );
  for (const [name, dockerfile] of [["API", dockerApi], ["web", dockerWeb]]) {
    requireMatch(
      dockerfile,
      /pnpm config set network-concurrency 4/,
      `${name} image install must retain its memory-safe pnpm network concurrency`,
    );
    requireMatch(
      dockerfile,
      /pnpm config set child-concurrency 1/,
      `${name} image install must retain its memory-safe pnpm child concurrency`,
    );
    requireMatch(
      dockerfile,
      /ARG PNPM_LOCKFILE_PREVERIFIED=false[\s\S]+--config\.trust-lockfile=\$\{PNPM_LOCKFILE_PREVERIFIED\}/,
      `${name} image must verify its lockfile unless the caller explicitly proves a prior gate`,
    );
    for (const platformFlag of ["--os=linux", "--cpu=x64", "--libc=glibc"]) {
      requireMatch(
        dockerfile,
        new RegExp(platformFlag.replace("-", "\\-")),
        `${name} image install must retain its explicit Linux x64 glibc target`,
      );
    }
  }

  let pinnedJobImageCount = 0;
  for (const [name, block] of blocks) {
    const imageDeclaration = block.match(/^  image:\s*(.*)$/m);
    if (!imageDeclaration) continue;
    const inlineReference = imageDeclaration[1].trim();
    const nestedReference = block.match(/^  image:\s*\n    name:\s*(\S+)\s*$/m)?.[1];
    const imageReference = (inlineReference || nestedReference || "")
      .replace(/^['"]|['"]$/g, "");
    if (!imageReference) policyFailure(`job or template ${name} has an unresolved image`);
    requireMatch(
      imageReference,
      /@sha256:[0-9a-f]{64}$/,
      `job or template ${name} does not pin its image by digest`,
    );
    pinnedJobImageCount += 1;
  }
  if (pinnedJobImageCount < 4) policyFailure("expected all CI tool images to be explicit");

  const nonJobKeys = new Set(["stages", "default", "variables", "workflow", "include"]);
  const resolveInheritedBlock = (name, predicate, chain = new Set()) => {
    if (chain.has(name)) policyFailure(`cyclic extends chain while resolving ${name}`);
    const block = requiredBlock(blocks, name);
    if (predicate(block)) return block;
    const parent = block.match(/^  extends:\s*([^\s]+)\s*$/m)?.[1];
    if (!parent) return undefined;
    return resolveInheritedBlock(parent, predicate, new Set([...chain, name]));
  };
  const effectiveJobSource = (name, chain = new Set()) => {
    if (chain.has(name)) policyFailure(`cyclic extends chain while resolving ${name}`);
    const block = requiredBlock(blocks, name);
    const parent = block.match(/^  extends:\s*([^\s]+)\s*$/m)?.[1];
    return parent
      ? `${effectiveJobSource(parent, new Set([...chain, name]))}\n${block}`
      : block;
  };
  const stages = declaredStages(blocks);
  for (let index = 0; index < REVIEWED_STAGES.length; index += 1) {
    if (stages[index] !== REVIEWED_STAGES[index]) {
      policyFailure(`reviewed stage ${REVIEWED_STAGES[index]} is missing or reordered`);
    }
  }

  const executableJobs = [...blocks.keys()].filter(
    (name) => !name.startsWith(".") && !nonJobKeys.has(name),
  );
  const jobsByStage = new Map(stages.map((stage) => [stage, []]));
  for (const name of executableJobs) {
    const stageBlock = resolveInheritedBlock(
      name,
      (block) => /^\s{2}stage:\s*\S+\s*$/m.test(block),
    );
    const stage = stageBlock?.match(/^\s{2}stage:\s*(\S+)\s*$/m)?.[1];
    if (!stage || !jobsByStage.has(stage)) {
      policyFailure(`job ${name} must use an explicitly declared stage`);
    }
    jobsByStage.get(stage).push(name);

    const reviewedStage = REVIEWED_JOBS.get(name);
    if (reviewedStage) {
      if (stage !== reviewedStage) {
        policyFailure(`reviewed job ${name} must remain in stage ${reviewedStage}`);
      }
      if (PROMOTION_COMMAND.test(effectiveJobSource(name))) {
        policyFailure(`reviewed non-promotion job ${name} contains a promotion command`);
      }
      continue;
    }

    const stageIndex = stages.indexOf(stage);
    if (stageIndex <= stages.indexOf("provenance")) {
      policyFailure(
        `unreviewed executable job ${name} must use a declared post-provenance stage`,
      );
    }
    const needsBlock = resolveInheritedBlock(name, (block) => /^  needs:/m.test(block));
    requireMatch(
      needsBlock ?? "",
      /job:\s*verify-image-provenance[\s\S]+artifacts:\s*true/,
      `promotion job ${name} must need verify-image-provenance and consume its artifacts`,
    );
    const rulesBlock = resolveInheritedBlock(name, (block) => /^  rules:/m.test(block));
    requireMatch(
      rulesBlock ?? "",
      /rules:\s*\*image-build-rules/,
      `promotion job ${name} must use protected-ref image publication rules`,
    );
    const scriptBlock = resolveInheritedBlock(name, (block) => /^  script:/m.test(block));
    for (const variable of ["API_IMAGE", "WEB_IMAGE"]) {
      requireMatch(
        scriptBlock ?? "",
        new RegExp(`\\$(?:\\{${variable}\\}|${variable}\\b)`),
        `promotion job ${name} must consume verified ${variable}`,
      );
    }
  }
  for (const stage of stages.slice(REVIEWED_STAGES.length)) {
    if ((jobsByStage.get(stage) ?? []).length === 0) {
      policyFailure(`unreviewed stage ${stage} has no explicit promotion job`);
    }
  }
  for (const name of blocks.keys()) {
    if (name.startsWith(".") || nonJobKeys.has(name)) continue;
    if (!resolveInheritedBlock(name, (block) => /^  image:/m.test(block))) {
      policyFailure(`job ${name} must declare or inherit a digest-pinned image`);
    }
    if (!resolveInheritedBlock(
      name,
      (block) => /^  resource_group:\s*denicheur-breizh-ci\s*$/m.test(block),
    )) {
      policyFailure(`job ${name} must declare or inherit the project-wide runner quota lock`);
    }
  }
  requireMatch(
    ci,
    new RegExp(COSIGN_JOB_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "Cosign job image digest changed without updating the policy harness",
  );
  requireMatch(
    ci,
    new RegExp(KANIKO_BUILDER_IMAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "Kaniko builder image digest changed without updating the policy harness",
  );

  const protectedRuleCount = (ci.match(/CI_COMMIT_REF_PROTECTED\s*==\s*"true"/g) ?? []).length;
  if (protectedRuleCount < 2) {
    policyFailure("branch and tag image publication rules must both require protected refs");
  }
  requireMatch(
    ci,
    /node scripts\/ci\/check-image-provenance-ci\.mjs --self-test/,
    "check-workspace must execute the deterministic policy/tamper harness",
  );
  requireMatch(
    ci,
    /node scripts\/ci\/test-provision-gitlab-cosign\.mjs/,
    "check-workspace must exercise the secret-safe GitLab provisioning harness",
  );
  requireMatch(
    ci,
    /corepack prepare pnpm@11\.17\.0 --activate/,
    "CI must use the workspace pnpm version",
  );
  requireMatch(
    ci,
    /^  KUBERNETES_CPU_LIMIT: "1"$/m,
    "CI jobs must retain the runner-quota CPU cap",
  );
  requireMatch(
    ci,
    /^  KUBERNETES_HELPER_CPU_LIMIT: "100m"$/m,
    "CI helper jobs must retain the runner-quota CPU cap",
  );
  requireMatch(
    ci,
    /^  KUBERNETES_MEMORY_LIMIT: "1Gi"$/m,
    "CI jobs must retain teardown headroom under the runner memory quota",
  );
  requireMatch(
    ci,
    /^  KUBERNETES_HELPER_MEMORY_LIMIT: "128Mi"$/m,
    "CI helper jobs must retain teardown headroom under the runner memory quota",
  );
  requireMatch(
    ci,
    new RegExp(`REGISTRY_PUSH_HOST: ${CANONICAL_REGISTRY_HOST.replaceAll(".", "\\.")}`),
    "image pushes must use the TLS certificate's canonical registry hostname",
  );
  requireMatch(
    ci,
    new RegExp(`REGISTRY_PULL_HOST: ${CANONICAL_REGISTRY_HOST.replaceAll(".", "\\.")}`),
    "image evidence must use the canonical registry hostname",
  );
  const workspaceBlock = requiredBlock(blocks, "check-workspace");
  requireMatch(
    workspaceBlock,
    /^    TURBO_CONCURRENCY: "1"$/m,
    "workspace tasks must remain serialized within the single-CPU runner pod",
  );
  requireMatch(workspaceBlock, /test -z "\$\{COSIGN_PRIVATE_KEY_FILE:-\}" && test -z "\$\{COSIGN_PASSWORD:-\}"/, "workspace validation must reject mis-scoped private signing variables before dependency installation");
  requireMatch(
    ci,
    /immutable_image="\$\{REGISTRY_PULL_HOST\}\/\$\{CI_PROJECT_PATH\}\/\$\{IMAGE_NAME\}@\$\{digest\}"/,
    "build artifacts must use a digest-only immutable image reference",
  );
  requireAbsent(
    ci,
    /immutable_image=.*:sha-\$\{CI_COMMIT_SHA\}@/,
    "immutable image evidence must not retain a mutable tag component",
  );

  const buildBlock = requiredBlock(blocks, ".build-image");
  requireMatch(
    buildBlock,
    /^    KUBERNETES_MEMORY_LIMIT: "1280Mi"$/m,
    "image builders must retain their quota-safe Kaniko memory profile",
  );
  requireMatch(buildBlock, /test -z "\$\{COSIGN_PRIVATE_KEY_FILE:-\}" && test -z "\$\{COSIGN_PASSWORD:-\}"/, "image builders must reject mis-scoped private signing variables");
  requireMatch(
    buildBlock,
    /needs:\s*\n\s*- check-workspace/,
    "image builders may trust the lockfile only after the workspace verification gate",
  );
  requireMatch(
    buildBlock,
    /--build-arg PNPM_LOCKFILE_PREVERIFIED=true/,
    "CI image builders must declare that the required workspace gate preverified the lockfile",
  );
  requireMatch(buildBlock, /if \[ -n "\$\{REGISTRY_INTERNAL_CA_FILE:-\}" \]; then/, "the registry CA extension must be optional");
  requireMatch(buildBlock, /ca-certificates\.crt[\s\S]+REGISTRY_INTERNAL_CA_FILE/, "Kaniko must append a configured CA without disabling system trust");
  requireAbsent(
    buildBlock,
    /--cache-copy-layers(?:=true)?(?:\s|\\|$)/,
    "Kaniko must not publish copy-layer caches concurrently with dependency installation",
  );
  const cosignBlock = requiredBlock(blocks, ".cosign-job");
  requireMatch(cosignBlock, /entrypoint:\s*\[""\]/, "Cosign job must expose a GitLab-compatible shell entrypoint");
  requireMatch(cosignBlock, /rules:\s*\*image-build-rules/, "Cosign jobs must inherit protected-ref rules");

  const signBlock = requiredBlock(blocks, "sign-image-provenance");
  requireMatch(signBlock, /stage:\s*attest/, "signing must run in the attest stage");
  requireMatch(signBlock, /environment:[\s\S]+name:\s*cosign-signing[\s\S]+action:\s*prepare/, "private signing variables must be isolated to the cosign-signing environment scope");
  requireMatch(signBlock, /job:\s*build-api-image[\s\S]+artifacts:\s*true/, "signing must consume API build artifacts");
  requireMatch(signBlock, /job:\s*build-web-image[\s\S]+artifacts:\s*true/, "signing must consume web build artifacts");
  requireMatch(signBlock, /sh scripts\/ci\/sign-image-provenance\.sh/, "signing job must use the reviewed helper");

  requireMatch(sign, /COSIGN_PRIVATE_KEY_FILE/, "signing must require the external private-key File variable");
  requireMatch(sign, /COSIGN_PUBLIC_KEY_FILE/, "signing must require the external public-key File variable");
  requireMatch(sign, /cosign public-key[\s\S]+cmp -s/, "signing must prove the configured key pair matches");
  requireMatch(sign, /COSIGN_EXPERIMENTAL=1 cosign_registry sign[\s\S]+--key "\$\{COSIGN_PRIVATE_KEY_FILE\}"/, "registry image must be cryptographically signed with GitLab OCI 1.1 support enabled");
  requireMatch(sign, /cosign_registry attest[\s\S]+--type slsaprovenance1/, "registry image must receive a SLSA v1 attestation");
  requireMatch(sign, /--registry-referrers-mode oci-1-1/, "Cosign signatures must use GitLab's OCI 1.1 subject association");
  if ((sign.match(/--use-signing-config=false/g) ?? []).length < 2) {
    policyFailure("private-key signing must disable public Sigstore service discovery");
  }
  requireMatch(common, /\[ -n "\$\{REGISTRY_INTERNAL_CA_FILE:-\}" \] \|\| return 0/, "the additional registry CA must be optional");
  requireMatch(common, /cosign_registry\(\)[\s\S]+--registry-cacert "\$\{REGISTRY_INTERNAL_CA_FILE\}"[\s\S]+cosign "\$\{provenance_cosign_command\}" "\$@"/, "Cosign must preserve public trust by default and add the configured CA only when present");
  requireMatch(sign, /"\$\{EVIDENCE_IMAGE\}"/, "Cosign must sign the validated digest-only reference");
  requireMatch(common, /subjectDigest/, "SLSA predicate must bind the expected subject digest semantically");

  const cryptographyBlock = requiredBlock(blocks, "verify-image-cryptography");
  requireMatch(cryptographyBlock, /job:\s*sign-image-provenance[\s\S]+artifacts:\s*true/, "cryptographic verification must consume signed evidence");
  requireMatch(cryptographyBlock, /sh scripts\/ci\/verify-image-cryptography\.sh/, "cryptographic verifier must use the reviewed helper");
  requireMatch(cryptography, /cosign_registry verify \\/, "image signature verification is missing");
  requireMatch(cryptography, /cosign_registry verify-attestation \\/, "attestation verification is missing");
  if ((cryptography.match(/--output json/g) ?? []).length < 2) {
    policyFailure("both Cosign verification commands must emit deterministic JSON");
  }
  requireMatch(cryptography, /--type slsaprovenance1/, "attestation verifier must require SLSA provenance v1");
  requireMatch(cryptography, /--key "\$\{COSIGN_PUBLIC_KEY_FILE\}"/, "verification must use the external public-key File variable");
  requireMatch(cryptography, /\[ -z "\$\{COSIGN_PRIVATE_KEY_FILE:-\}" \][\s\S]+\[ -z "\$\{COSIGN_PASSWORD:-\}" \]/, "verification must fail when signing variables are mis-scoped into its environment");
  requireAbsent(cryptographyBlock, /environment:\s*[\s\S]*cosign-signing/, "verification jobs must not use the signing-secret environment scope");

  const provenanceBlock = requiredBlock(blocks, "verify-image-provenance");
  requireMatch(provenanceBlock, /stage:\s*provenance/, "semantic verification must be the final provenance stage");
  requireMatch(provenanceBlock, /job:\s*verify-image-cryptography[\s\S]+artifacts:\s*true/, "semantic verification must consume cryptographically verified output");
  requireMatch(provenanceBlock, /node scripts\/ci\/verify-image-provenance\.mjs/, "semantic provenance verifier is missing");
  requireMatch(provenanceBlock, /test -z "\$\{COSIGN_PRIVATE_KEY_FILE:-\}" && test -z "\$\{COSIGN_PASSWORD:-\}"/, "semantic verification must reject mis-scoped private signing variables");
  requireMatch(provenanceBlock, /dotenv:\s*verified-images\.env/, "only the final verifier may publish deployable image references");
  requireMatch(semantic, /https:\/\/slsa\.dev\/provenance\/v1/, "semantic verifier must require the exact SLSA predicate type");
  requireMatch(semantic, /subjectDigest/, "semantic verifier must require the signed subject digest");
  requireMatch(semantic, /sourceRevision/, "semantic verifier must require the signed source revision");

}

function expectRejected(label, operation) {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error(`tamper harness did not reject: ${label}`);
}

function semanticTamperHarness() {
  const context = {
    projectPath: "research-and-development/denicheur-breizh",
    projectUrl: "https://gitlab.orchid-labs.xyz/research-and-development/denicheur-breizh",
    revision: "a".repeat(40),
    pipelineId: "1234",
    registryPullHost: CANONICAL_REGISTRY_HOST,
  };
  const imageName = "api";
  const digest = `sha256:${"b".repeat(64)}`;
  const buildJobId = "5678";
  const image = `${context.registryPullHost}/${context.projectPath}/${imageName}@${digest}`;
  const provenance = createExpectedPredicate(context, imageName, buildJobId, digest);
  const annotations = {
    sourceProject: context.projectPath,
    sourceRevision: context.revision,
    pipelineId: context.pipelineId,
    buildJobId,
    imageName,
    builderImage: KANIKO_BUILDER_IMAGE,
  };
  const signatureDocuments = [{
    critical: {
      image: { "docker-manifest-digest": digest },
    },
    optional: annotations,
  }];
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{
      name: `${context.registryPullHost}/${context.projectPath}/${imageName}`,
      digest: { sha256: digest.slice("sha256:".length) },
    }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: provenance,
  };
  const envelope = (value) => [{
    payloadType: "application/vnd.in-toto+json",
    payload: Buffer.from(JSON.stringify(value), "utf8").toString("base64"),
    signatures: [{ keyid: "", sig: "fixture" }],
  }];
  const valid = {
    context,
    imageName,
    digest,
    image,
    buildJobId,
    provenance,
    signatureDocuments,
    attestationDocuments: envelope(statement),
  };

  validateImageEvidence(valid);
  expectRejected("digest mutation", () => validateImageEvidence({
    ...valid,
    digest: `sha256:${"c".repeat(64)}`,
  }));
  expectRejected("tag substituted for digest-only reference", () => validateImageEvidence({
    ...valid,
    image: `${context.registryPullHost}/${context.projectPath}/${imageName}:latest`,
  }));
  const tamperedStatement = structuredClone(statement);
  tamperedStatement.predicate.buildDefinition.externalParameters.source.digest.gitCommit =
    "d".repeat(40);
  expectRejected("signed source revision mutation", () => validateImageEvidence({
    ...valid,
    attestationDocuments: envelope(tamperedStatement),
  }));
  const tamperedSignature = structuredClone(signatureDocuments);
  tamperedSignature[0].optional.pipelineId = "9999";
  expectRejected("signed pipeline annotation mutation", () => validateImageEvidence({
    ...valid,
    signatureDocuments: tamperedSignature,
  }));
}

function shellPredicateParityHarness() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "denicheur-provenance-"));
  const outputPath = join(temporaryDirectory, "api.provenance.json");
  const context = {
    projectPath: "research-and-development/denicheur-breizh",
    projectUrl: "https://gitlab.orchid-labs.xyz/research-and-development/denicheur-breizh",
    revision: "a".repeat(40),
    pipelineId: "1234",
    registryPullHost: CANONICAL_REGISTRY_HOST,
  };
  const digest = `sha256:${"b".repeat(64)}`;
  const buildJobId = "5678";

  try {
    execFileSync(
      "sh",
      [
        "-c",
        '. "$1"; write_slsa_provenance "$2" "$3" "$4" "$5" "$6"',
        "sh",
        "scripts/ci/image-provenance-common.sh",
        "api",
        "Dockerfile.api",
        digest,
        buildJobId,
        outputPath,
      ],
      {
        env: {
          ...process.env,
          CI_PROJECT_URL: context.projectUrl,
          CI_COMMIT_SHA: context.revision,
          CI_PIPELINE_ID: context.pipelineId,
        },
        stdio: "pipe",
      },
    );
    const shellPredicate = JSON.parse(readFileSync(outputPath, "utf8"));
    const nodePredicate = createExpectedPredicate(
      context,
      "api",
      buildJobId,
      digest,
    );
    if (!isDeepStrictEqual(shellPredicate, nodePredicate)) {
      throw new Error("shell and semantic verifier disagree on the SLSA predicate");
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function shellPreconditionHarness() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "denicheur-ci-preconditions-"));
  const repositoryRoot = process.cwd();
  const baseEnvironment = {
    PATH: process.env.PATH,
    CI_PROJECT_DIR: repositoryRoot,
    CI_PROJECT_PATH: "research-and-development/denicheur-breizh",
    EXPECTED_PROJECT_PATH: "research-and-development/denicheur-breizh",
    CI_SERVER_URL: "https://gitlab.orchid-labs.xyz",
    EXPECTED_CI_SERVER_URL: "https://gitlab.orchid-labs.xyz",
    CI_PROJECT_URL: "https://gitlab.orchid-labs.xyz/research-and-development/denicheur-breizh",
    CI_COMMIT_SHA: "a".repeat(40),
    CI_PIPELINE_ID: "1234",
    CI_COMMIT_REF_PROTECTED: "true",
    REGISTRY_PULL_HOST: CANONICAL_REGISTRY_HOST,
    CI_REGISTRY_USER: "fixture-user",
    CI_REGISTRY_PASSWORD: "fixture-password",
  };

  try {
    const missingKey = spawnSync(
      "sh",
      [join(repositoryRoot, "scripts/ci/sign-image-provenance.sh")],
      { cwd: temporaryDirectory, env: baseEnvironment, encoding: "utf8" },
    );
    if (
      missingKey.status === 0 ||
      !missingKey.stderr.includes("required CI variable COSIGN_PASSWORD is missing")
    ) {
      throw new Error("signing helper did not fail closed on missing signing material");
    }

    const invalidOptionalCa = spawnSync(
      "sh",
      [join(repositoryRoot, "scripts/ci/sign-image-provenance.sh")],
      {
        cwd: temporaryDirectory,
        env: {
          ...baseEnvironment,
          REGISTRY_INTERNAL_CA_FILE: join(temporaryDirectory, "missing-ca.pem"),
        },
        encoding: "utf8",
      },
    );
    if (
      invalidOptionalCa.status === 0 ||
      !invalidOptionalCa.stderr.includes("must be a non-empty GitLab File variable")
    ) {
      throw new Error("signing helper accepted an invalid optional registry CA");
    }

    const leakedKey = spawnSync(
      "sh",
      [join(repositoryRoot, "scripts/ci/verify-image-cryptography.sh")],
      {
        cwd: temporaryDirectory,
        env: {
          ...baseEnvironment,
          COSIGN_PRIVATE_KEY_FILE: "/mis-scoped-private-key",
        },
        encoding: "utf8",
      },
    );
    if (
      leakedKey.status === 0 ||
      !leakedKey.stderr.includes("private signing variables must be scoped only")
    ) {
      throw new Error("verification helper did not reject mis-scoped private material");
    }

    expectRejected("semantic verifier receives private material", () =>
      createVerificationContext({
        ...baseEnvironment,
        COSIGN_PRIVATE_KEY_FILE: "/mis-scoped-private-key",
      }),
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function runSelfTest(sources) {
  validateCiSupplyChain(sources);

  const mutate = (overrides) => ({ ...sources, ...overrides });
  const addStage = (ci, stage) => ci.replace(
    "  - provenance\n",
    `  - provenance\n  - ${stage}\n`,
  );
  const insecureRegistryFlag = ["--allow", "insecure-registry"].join("-");
  const keyGenerationCommand = ["cosign generate", "key-pair"].join("-");
  expectRejected("unprotected publication", () => validateCiSupplyChain(mutate({
    ci: sources.ci.replaceAll(' && $CI_COMMIT_REF_PROTECTED == "true"', ""),
  })));
  expectRejected("runner quota lock removed", () => validateCiSupplyChain(mutate({
    ci: sources.ci.replaceAll("  resource_group: denicheur-breizh-ci\n", ""),
  })));
  expectRejected("runner memory cap raised", () => validateCiSupplyChain(mutate({
    ci: sources.ci.replace('  KUBERNETES_MEMORY_LIMIT: "1Gi"', '  KUBERNETES_MEMORY_LIMIT: "2Gi"'),
  })));
  expectRejected("builder memory profile raised to quota edge", () => validateCiSupplyChain(mutate({
    ci: sources.ci.replace('    KUBERNETES_MEMORY_LIMIT: "1280Mi"', '    KUBERNETES_MEMORY_LIMIT: "1408Mi"'),
  })));
  expectRejected("API image install concurrency raised", () => validateCiSupplyChain(mutate({
    dockerApi: sources.dockerApi.replace("pnpm config set network-concurrency 4", "pnpm config set network-concurrency 16"),
  })));
  expectRejected("local API image trusts an unverified lockfile", () => validateCiSupplyChain(mutate({
    dockerApi: sources.dockerApi.replace("ARG PNPM_LOCKFILE_PREVERIFIED=false", "ARG PNPM_LOCKFILE_PREVERIFIED=true"),
  })));
  expectRejected("CI builder drops its lockfile verification dependency", () => validateCiSupplyChain(mutate({
    ci: sources.ci.replace("  needs:\n    - check-workspace\n", "  needs: []\n"),
  })));
  expectRejected("workspace task serialization removed", () => validateCiSupplyChain(mutate({
    ci: sources.ci.replace('    TURBO_CONCURRENCY: "1"', '    TURBO_CONCURRENCY: "10"'),
  })));
  expectRejected("non-canonical registry push hostname", () => validateCiSupplyChain(mutate({
    ci: sources.ci.replace(
      `REGISTRY_PUSH_HOST: ${CANONICAL_REGISTRY_HOST}`,
      "REGISTRY_PUSH_HOST: gitlab-registry.gitlab.svc.cluster.local:32443",
    ),
  })));
  expectRejected("unpinned Cosign image", () => validateCiSupplyChain(mutate({
    ci: sources.ci.replace(COSIGN_JOB_IMAGE, "cgr.dev/chainguard/cosign:latest-dev"),
  })));
  expectRejected("missing registry attestation", () => validateCiSupplyChain(mutate({
    sign: sources.sign.replace("cosign_registry attest \\", "echo attest \\")
  })));
  expectRejected("registry TLS bypass", () => validateCiSupplyChain(mutate({
    cryptography: `${sources.cryptography}\ncosign verify ${insecureRegistryFlag} image`,
  })));
  expectRejected("in-repository key generation", () => validateCiSupplyChain(mutate({
    sign: `${sources.sign}\n${keyGenerationCommand}`,
  })));
  expectRejected("deploy bypasses verifier", () => validateCiSupplyChain(mutate({
    ci: `${sources.ci}\ndeploy-production:\n  stage: deploy\n  image: ${NODE_JOB_IMAGE}\n  script: echo deploy\n`,
  })));
  expectRejected("deploy uses an unpinned tool image", () => validateCiSupplyChain(mutate({
    ci: `${sources.ci}\ndeploy-production:\n  stage: deploy\n  image: node:24-bookworm-slim\n  needs:\n    - job: verify-image-provenance\n      artifacts: true\n  script: echo deploy\n`,
  })));
  expectRejected("included jobs evade static inspection", () => validateCiSupplyChain(mutate({
    ci: `${sources.ci}\ninclude:\n  - local: .gitlab/deploy.yml\n`,
  })));
  expectRejected("inherited deploy stage bypasses verifier", () => validateCiSupplyChain(mutate({
    ci: `${sources.ci}\n.deploy-template:\n  stage: deploy\n  image: ${NODE_JOB_IMAGE}\n  script: echo deploy\n\ndeploy-production:\n  extends: .deploy-template\n`,
  })));
  expectRejected("release stage bypasses verifier", () => validateCiSupplyChain(mutate({
    ci: `${addStage(sources.ci, "release")}\nrelease-images:\n  stage: release\n  resource_group: denicheur-breizh-ci\n  image: ${NODE_JOB_IMAGE}\n  script: echo release\n`,
  })));
  expectRejected("promote-named job bypasses verifier", () => validateCiSupplyChain(mutate({
    ci: `${sources.ci}\npromote-images:\n  stage: provenance\n  resource_group: denicheur-breizh-ci\n  image: ${NODE_JOB_IMAGE}\n  script: echo promote\n`,
  })));
  expectRejected("production job bypasses verifier", () => validateCiSupplyChain(mutate({
    ci: `${sources.ci}\nproduction:\n  stage: provenance\n  resource_group: denicheur-breizh-ci\n  image: ${NODE_JOB_IMAGE}\n  script: echo rollout\n`,
  })));
  expectRejected("custom later stage bypasses verifier", () => validateCiSupplyChain(mutate({
    ci: `${addStage(sources.ci, "ship")}\nship-images:\n  stage: ship\n  resource_group: denicheur-breizh-ci\n  image: ${NODE_JOB_IMAGE}\n  script: echo ship\n`,
  })));
  expectRejected("promotion ignores verified image references", () => validateCiSupplyChain(mutate({
    ci: `${addStage(sources.ci, "deploy")}\ndeploy-production:\n  stage: deploy\n  resource_group: denicheur-breizh-ci\n  image: ${NODE_JOB_IMAGE}\n  rules: *image-build-rules\n  needs:\n    - job: verify-image-provenance\n      artifacts: true\n  script: deployctl rollout --image registry.invalid/app:latest\n`,
  })));
  expectRejected("promotion drops protected-ref rules", () => validateCiSupplyChain(mutate({
    ci: `${addStage(sources.ci, "deploy")}\ndeploy-production:\n  stage: deploy\n  resource_group: denicheur-breizh-ci\n  image: ${NODE_JOB_IMAGE}\n  needs:\n    - job: verify-image-provenance\n      artifacts: true\n  script:\n    - deployctl rollout api --image "\${API_IMAGE}"\n    - deployctl rollout web --image "\${WEB_IMAGE}"\n`,
  })));

  validateCiSupplyChain(mutate({
    ci: `${addStage(sources.ci, "deploy")}\ndeploy-production:\n  stage: deploy\n  resource_group: denicheur-breizh-ci\n  image: ${NODE_JOB_IMAGE}\n  rules: *image-build-rules\n  needs:\n    - job: verify-image-provenance\n      artifacts: true\n  script:\n    - deployctl rollout api --image "\${API_IMAGE}"\n    - deployctl rollout web --image "\${WEB_IMAGE}"\n`,
  }));
  semanticTamperHarness();
  shellPredicateParityHarness();
  shellPreconditionHarness();
}

const sources = {
  ci: readFileSync(".gitlab-ci.yml", "utf8"),
  common: readFileSync("scripts/ci/image-provenance-common.sh", "utf8"),
  sign: readFileSync("scripts/ci/sign-image-provenance.sh", "utf8"),
  cryptography: readFileSync("scripts/ci/verify-image-cryptography.sh", "utf8"),
  semantic: readFileSync("scripts/ci/verify-image-provenance.mjs", "utf8"),
  dockerApi: readFileSync("Dockerfile.api", "utf8"),
  dockerWeb: readFileSync("Dockerfile.web", "utf8"),
};

try {
  if (process.argv.includes("--self-test")) runSelfTest(sources);
  else validateCiSupplyChain(sources);
  console.log(
    process.argv.includes("--self-test")
      ? "CI image provenance policy and tamper harnesses passed."
      : "CI image provenance policy passed.",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
