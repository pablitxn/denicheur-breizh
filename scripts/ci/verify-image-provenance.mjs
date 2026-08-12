import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

export const KANIKO_BUILDER_IMAGE =
  "gcr.io/kaniko-project/executor:v1.23.2-debug@sha256:c3109d5926a997b100c4343944e06c6b30a6804b2f9abe0994d3de6ef92b028e";
export const SLSA_BUILD_TYPE =
  "https://gitlab.orchid-labs.xyz/research-and-development/denicheur-breizh/-/slsa/build-types/kaniko/v1";

const IMAGE_NAMES = ["api", "web"];
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REVISION_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const INTEGER_PATTERN = /^\d+$/;

function fail(message) {
  throw new Error(`image provenance: ${message}`);
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.length === 0) {
    fail(`required CI variable ${name} is missing`);
  }
  return value;
}

export function createVerificationContext(environment = process.env) {
  if (environment.COSIGN_PRIVATE_KEY_FILE || environment.COSIGN_PASSWORD) {
    fail("private signing variables must be scoped only to the cosign-signing environment");
  }
  const projectPath = requiredEnvironment(environment, "CI_PROJECT_PATH");
  const expectedProjectPath = requiredEnvironment(environment, "EXPECTED_PROJECT_PATH");
  const serverUrl = requiredEnvironment(environment, "CI_SERVER_URL");
  const expectedServerUrl = requiredEnvironment(environment, "EXPECTED_CI_SERVER_URL");
  const projectUrl = requiredEnvironment(environment, "CI_PROJECT_URL");
  const revision = requiredEnvironment(environment, "CI_COMMIT_SHA");
  const pipelineId = requiredEnvironment(environment, "CI_PIPELINE_ID");
  const protectedRef = requiredEnvironment(environment, "CI_COMMIT_REF_PROTECTED");
  const registryPullHost = requiredEnvironment(environment, "REGISTRY_PULL_HOST");

  if (projectPath !== expectedProjectPath) fail("unexpected CI project path");
  if (serverUrl !== expectedServerUrl) fail("unexpected GitLab server URL");
  if (projectUrl !== `${expectedServerUrl}/${expectedProjectPath}`) {
    fail("unexpected GitLab project URL");
  }
  if (protectedRef !== "true") fail("image verification is restricted to protected refs");
  if (!REVISION_PATTERN.test(revision)) fail("invalid CI revision");
  if (!INTEGER_PATTERN.test(pipelineId)) fail("invalid CI pipeline id");
  if (!/^[a-zA-Z0-9._:-]+$/.test(registryPullHost)) {
    fail("REGISTRY_PULL_HOST contains unsafe characters");
  }

  return {
    projectPath,
    projectUrl,
    revision,
    pipelineId,
    registryPullHost,
  };
}

export function createExpectedPredicate(context, imageName, buildJobId, digest) {
  if (!IMAGE_NAMES.includes(imageName)) fail(`unexpected image name ${imageName}`);
  if (!INTEGER_PATTERN.test(buildJobId)) fail(`${imageName}: invalid build job id`);
  if (!DIGEST_PATTERN.test(digest)) fail(`${imageName}: invalid digest`);

  const dockerfile = imageName === "api" ? "Dockerfile.api" : "Dockerfile.web";
  const sourceUri = `git+${context.projectUrl}.git`;
  return {
    buildDefinition: {
      buildType: SLSA_BUILD_TYPE,
      externalParameters: {
        source: {
          uri: sourceUri,
          digest: { gitCommit: context.revision },
        },
        image: imageName,
        dockerfile,
      },
      internalParameters: {
        pipelineId: context.pipelineId,
        buildJobId,
        subjectDigest: digest,
        builderImage: KANIKO_BUILDER_IMAGE,
      },
      resolvedDependencies: [
        {
          uri: sourceUri,
          digest: { gitCommit: context.revision },
        },
        {
          uri: KANIKO_BUILDER_IMAGE,
          digest: { sha256: KANIKO_BUILDER_IMAGE.split("@sha256:")[1] },
        },
      ],
    },
    runDetails: {
      builder: { id: SLSA_BUILD_TYPE },
      metadata: {
        invocationId: `${context.projectUrl}/-/pipelines/${context.pipelineId}#job-${buildJobId}`,
      },
    },
  };
}

export function parseJsonDocuments(source, label) {
  const trimmed = source.trim();
  if (!trimmed) fail(`${label} is empty`);

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
    try {
      return lines.flatMap((line) => {
        const parsed = JSON.parse(line);
        return Array.isArray(parsed) ? parsed : [parsed];
      });
    } catch (error) {
      fail(`${label} is neither JSON nor JSON Lines: ${error.message}`);
    }
  }
}

function decodeBase64Json(payload) {
  if (typeof payload !== "string" || payload.length === 0) return undefined;
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(payload)) return undefined;

  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

function collectObjects(value, seen = new Set(), output = []) {
  if (!value || typeof value !== "object" || seen.has(value)) return output;
  seen.add(value);
  output.push(value);

  if (typeof value.payload === "string") {
    const decoded = decodeBase64Json(value.payload);
    if (decoded) collectObjects(decoded, seen, output);
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    collectObjects(child, seen, output);
  }
  return output;
}

function expectedSignatureAnnotations(context, imageName, buildJobId) {
  return {
    sourceProject: context.projectPath,
    sourceRevision: context.revision,
    pipelineId: context.pipelineId,
    buildJobId,
    imageName,
    builderImage: KANIKO_BUILDER_IMAGE,
  };
}

function hasExpectedSignature(documents, context, imageName, buildJobId, digest) {
  const expectedAnnotations = expectedSignatureAnnotations(
    context,
    imageName,
    buildJobId,
  );
  return documents
    .flatMap((document) => collectObjects(document))
    .some((candidate) => {
      const critical = candidate.critical ?? candidate.Critical;
      const optional = candidate.optional ?? candidate.Optional;
      const image = critical?.image ?? critical?.Image;
      const claimedDigest =
        image?.["docker-manifest-digest"] ?? image?.["Docker-manifest-digest"];
      if (claimedDigest !== digest || !optional || typeof optional !== "object") {
        return false;
      }
      return Object.entries(expectedAnnotations).every(
        ([key, value]) => optional[key] === value,
      );
    });
}

function hasExpectedAttestation(
  documents,
  context,
  imageName,
  digest,
  expectedPredicate,
) {
  const repository = `${context.registryPullHost}/${context.projectPath}/${imageName}`;
  const digestHex = digest.slice("sha256:".length);
  return documents
    .flatMap((document) => collectObjects(document))
    .some((candidate) => {
      if (
        candidate._type !== "https://in-toto.io/Statement/v1" &&
        candidate._type !== "https://in-toto.io/Statement/v0.1"
      ) {
        return false;
      }
      if (candidate.predicateType !== "https://slsa.dev/provenance/v1") return false;
      if (!Array.isArray(candidate.subject) || candidate.subject.length !== 1) return false;
      const [subject] = candidate.subject;
      if (subject?.name !== repository) return false;
      if (!isDeepStrictEqual(subject.digest, { sha256: digestHex })) return false;
      return isDeepStrictEqual(candidate.predicate, expectedPredicate);
    });
}

export function validateImageEvidence({
  context,
  imageName,
  digest,
  image,
  buildJobId,
  provenance,
  signatureDocuments,
  attestationDocuments,
}) {
  if (!IMAGE_NAMES.includes(imageName)) fail(`unexpected image name ${imageName}`);
  if (!DIGEST_PATTERN.test(digest)) fail(`${imageName}: invalid digest`);
  if (!INTEGER_PATTERN.test(buildJobId)) fail(`${imageName}: invalid build job id`);

  const expectedImage =
    `${context.registryPullHost}/${context.projectPath}/${imageName}@${digest}`;
  if (image !== expectedImage) fail(`${imageName}: immutable image reference mismatch`);

  const expectedPredicate = createExpectedPredicate(
    context,
    imageName,
    buildJobId,
    digest,
  );
  if (!isDeepStrictEqual(provenance, expectedPredicate)) {
    fail(`${imageName}: provenance artifact does not match the expected invocation`);
  }
  if (
    !hasExpectedSignature(
      signatureDocuments,
      context,
      imageName,
      buildJobId,
      digest,
    )
  ) {
    fail(`${imageName}: verified signature payload is not bound to the expected build`);
  }
  if (
    !hasExpectedAttestation(
      attestationDocuments,
      context,
      imageName,
      digest,
      expectedPredicate,
    )
  ) {
    fail(`${imageName}: verified SLSA attestation does not match the expected build`);
  }

  return expectedImage;
}

function readTrimmed(path) {
  const source = readFileSync(path, "utf8");
  if (!/^[^\r\n]+\n$/.test(source)) {
    fail(`${path} must contain exactly one newline-terminated value`);
  }
  return source.trim();
}

export function verifyWorkspaceEvidence(environment = process.env) {
  const context = createVerificationContext(environment);
  const buildJobIds = new Set();
  const verifiedImages = new Map();

  for (const imageName of IMAGE_NAMES) {
    const digest = readTrimmed(`${imageName}.digest`);
    const image = readTrimmed(`${imageName}.image`);
    const buildJobId = readTrimmed(`${imageName}.build-job-id`);
    if (buildJobIds.has(buildJobId)) {
      fail("api and web must originate from distinct build jobs");
    }
    buildJobIds.add(buildJobId);

    const provenance = JSON.parse(
      readFileSync(`${imageName}.provenance.json`, "utf8"),
    );
    const signatureDocuments = parseJsonDocuments(
      readFileSync(`${imageName}.signature-verification.json`, "utf8"),
      `${imageName} signature verification output`,
    );
    const attestationDocuments = parseJsonDocuments(
      readFileSync(`${imageName}.attestation-verification.json`, "utf8"),
      `${imageName} attestation verification output`,
    );

    const verifiedImage = validateImageEvidence({
      context,
      imageName,
      digest,
      image,
      buildJobId,
      provenance,
      signatureDocuments,
      attestationDocuments,
    });
    verifiedImages.set(imageName, verifiedImage);
    console.log(`Verified signed registry provenance: ${verifiedImage}`);
  }

  const dotenv = [
    `API_IMAGE=${verifiedImages.get("api")}`,
    `WEB_IMAGE=${verifiedImages.get("web")}`,
    "",
  ].join("\n");
  writeFileSync("verified-images.env", dotenv, { encoding: "utf8", mode: 0o600 });
  return verifiedImages;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    verifyWorkspaceEvidence();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
