#!/bin/sh

# Shared fail-closed validation for the Cosign signing and verification jobs.
# Keep this POSIX-sh compatible: the GitLab job runs in a minimal image.

KANIKO_BUILDER_IMAGE='gcr.io/kaniko-project/executor:v1.23.2-debug@sha256:c3109d5926a997b100c4343944e06c6b30a6804b2f9abe0994d3de6ef92b028e'
SLSA_BUILD_TYPE='https://gitlab.orchid-labs.xyz/research-and-development/denicheur-breizh/-/slsa/build-types/kaniko/v1'

provenance_fail() {
  printf '%s\n' "image provenance: $*" >&2
  exit 1
}

require_nonempty() {
  provenance_name="$1"
  provenance_value="$2"
  [ -n "${provenance_value}" ] || provenance_fail "required CI variable ${provenance_name} is missing"
}

require_pem_file() {
  provenance_name="$1"
  provenance_path="$2"
  provenance_begin="$3"
  provenance_end="$4"

  require_nonempty "${provenance_name}" "${provenance_path}"
  [ -f "${provenance_path}" ] && [ -s "${provenance_path}" ] \
    || provenance_fail "${provenance_name} must be a non-empty GitLab File variable"
  [ ! -L "${provenance_path}" ] \
    || provenance_fail "${provenance_name} must not resolve through a symbolic link"
  grep -Fqx -- "${provenance_begin}" "${provenance_path}" \
    || provenance_fail "${provenance_name} has an unexpected PEM header"
  grep -Fqx -- "${provenance_end}" "${provenance_path}" \
    || provenance_fail "${provenance_name} has an unexpected PEM footer"
}

validate_ci_identity() {
  require_nonempty CI_PROJECT_PATH "${CI_PROJECT_PATH:-}"
  require_nonempty EXPECTED_PROJECT_PATH "${EXPECTED_PROJECT_PATH:-}"
  require_nonempty CI_SERVER_URL "${CI_SERVER_URL:-}"
  require_nonempty EXPECTED_CI_SERVER_URL "${EXPECTED_CI_SERVER_URL:-}"
  require_nonempty CI_PROJECT_URL "${CI_PROJECT_URL:-}"
  require_nonempty CI_COMMIT_SHA "${CI_COMMIT_SHA:-}"
  require_nonempty CI_PIPELINE_ID "${CI_PIPELINE_ID:-}"
  require_nonempty CI_COMMIT_REF_PROTECTED "${CI_COMMIT_REF_PROTECTED:-}"
  require_nonempty REGISTRY_PULL_HOST "${REGISTRY_PULL_HOST:-}"
  require_nonempty CI_REGISTRY_USER "${CI_REGISTRY_USER:-}"
  require_nonempty CI_REGISTRY_PASSWORD "${CI_REGISTRY_PASSWORD:-}"

  [ "${CI_PROJECT_PATH}" = "${EXPECTED_PROJECT_PATH}" ] \
    || provenance_fail "unexpected CI project path"
  [ "${CI_SERVER_URL}" = "${EXPECTED_CI_SERVER_URL}" ] \
    || provenance_fail "unexpected GitLab server URL"
  [ "${CI_PROJECT_URL}" = "${EXPECTED_CI_SERVER_URL}/${EXPECTED_PROJECT_PATH}" ] \
    || provenance_fail "unexpected GitLab project URL"
  [ "${CI_COMMIT_REF_PROTECTED}" = true ] \
    || provenance_fail "image publication is restricted to protected refs"

  case "${CI_COMMIT_SHA}" in
    *[!0-9a-f]*|'') provenance_fail "CI_COMMIT_SHA is not lowercase hexadecimal" ;;
  esac
  case "${#CI_COMMIT_SHA}" in
    40|64) ;;
    *) provenance_fail "CI_COMMIT_SHA has an unexpected length" ;;
  esac
  case "${CI_PIPELINE_ID}" in
    *[!0-9]*|'') provenance_fail "CI_PIPELINE_ID is not numeric" ;;
  esac
  case "${REGISTRY_PULL_HOST}" in
    *[!a-zA-Z0-9._:-]*|'') provenance_fail "REGISTRY_PULL_HOST contains unsafe characters" ;;
  esac
}

validate_registry_ca() {
  [ -n "${REGISTRY_INTERNAL_CA_FILE:-}" ] || return 0
  require_pem_file \
    REGISTRY_INTERNAL_CA_FILE \
    "${REGISTRY_INTERNAL_CA_FILE:-}" \
    '-----BEGIN CERTIFICATE-----' \
    '-----END CERTIFICATE-----'
}

cosign_registry() {
  provenance_cosign_command="$1"
  shift
  if [ -n "${REGISTRY_INTERNAL_CA_FILE:-}" ]; then
    cosign "${provenance_cosign_command}" \
      --registry-cacert "${REGISTRY_INTERNAL_CA_FILE}" \
      "$@"
  else
    cosign "${provenance_cosign_command}" "$@"
  fi
}

validate_single_line_file() {
  provenance_path="$1"
  [ -f "${provenance_path}" ] && [ -s "${provenance_path}" ] \
    || provenance_fail "missing non-empty artifact ${provenance_path}"
  [ ! -L "${provenance_path}" ] \
    || provenance_fail "artifact ${provenance_path} must not be a symbolic link"
  [ "$(wc -l < "${provenance_path}" | tr -d ' ')" = 1 ] \
    || provenance_fail "artifact ${provenance_path} must contain exactly one line"
}

load_image_evidence() {
  EVIDENCE_IMAGE_NAME="$1"
  case "${EVIDENCE_IMAGE_NAME}" in
    api|web) ;;
    *) provenance_fail "unexpected image name ${EVIDENCE_IMAGE_NAME}" ;;
  esac

  validate_single_line_file "${EVIDENCE_IMAGE_NAME}.digest"
  validate_single_line_file "${EVIDENCE_IMAGE_NAME}.image"
  validate_single_line_file "${EVIDENCE_IMAGE_NAME}.build-job-id"

  EVIDENCE_DIGEST="$(sed -n '1p' "${EVIDENCE_IMAGE_NAME}.digest" | tr -d '\r')"
  EVIDENCE_IMAGE="$(sed -n '1p' "${EVIDENCE_IMAGE_NAME}.image" | tr -d '\r')"
  EVIDENCE_BUILD_JOB_ID="$(sed -n '1p' "${EVIDENCE_IMAGE_NAME}.build-job-id" | tr -d '\r')"

  case "${EVIDENCE_DIGEST}" in
    sha256:????????????????????????????????????????????????????????????????) ;;
    *) provenance_fail "${EVIDENCE_IMAGE_NAME}: digest must be sha256 plus 64 hexadecimal characters" ;;
  esac
  case "${EVIDENCE_DIGEST#sha256:}" in
    *[!0-9a-f]*|'') provenance_fail "${EVIDENCE_IMAGE_NAME}: digest is not lowercase hexadecimal" ;;
  esac
  case "${EVIDENCE_BUILD_JOB_ID}" in
    *[!0-9]*|'') provenance_fail "${EVIDENCE_IMAGE_NAME}: build job id is not numeric" ;;
  esac

  EVIDENCE_REPOSITORY="${REGISTRY_PULL_HOST}/${CI_PROJECT_PATH}/${EVIDENCE_IMAGE_NAME}"
  EVIDENCE_EXPECTED_IMAGE="${EVIDENCE_REPOSITORY}@${EVIDENCE_DIGEST}"
  [ "${EVIDENCE_IMAGE}" = "${EVIDENCE_EXPECTED_IMAGE}" ] \
    || provenance_fail "${EVIDENCE_IMAGE_NAME}: immutable image reference mismatch"
}

write_slsa_provenance() {
  provenance_image_name="$1"
  provenance_dockerfile="$2"
  provenance_digest="$3"
  provenance_build_job_id="$4"
  provenance_path="$5"
  provenance_source_uri="git+${CI_PROJECT_URL}.git"

  printf '%s\n' \
    '{' \
    '  "buildDefinition": {' \
    "    \"buildType\": \"${SLSA_BUILD_TYPE}\"," \
    '    "externalParameters": {' \
    "      \"source\": {\"uri\": \"${provenance_source_uri}\", \"digest\": {\"gitCommit\": \"${CI_COMMIT_SHA}\"}}," \
    "      \"image\": \"${provenance_image_name}\"," \
    "      \"dockerfile\": \"${provenance_dockerfile}\"" \
    '    },' \
    '    "internalParameters": {' \
    "      \"pipelineId\": \"${CI_PIPELINE_ID}\"," \
    "      \"buildJobId\": \"${provenance_build_job_id}\"," \
    "      \"subjectDigest\": \"${provenance_digest}\"," \
    "      \"builderImage\": \"${KANIKO_BUILDER_IMAGE}\"" \
    '    },' \
    '    "resolvedDependencies": [' \
    "      {\"uri\": \"${provenance_source_uri}\", \"digest\": {\"gitCommit\": \"${CI_COMMIT_SHA}\"}}," \
    "      {\"uri\": \"${KANIKO_BUILDER_IMAGE}\", \"digest\": {\"sha256\": \"${KANIKO_BUILDER_IMAGE##*@sha256:}\"}}" \
    '    ]' \
    '  },' \
    '  "runDetails": {' \
    "    \"builder\": {\"id\": \"${SLSA_BUILD_TYPE}\"}," \
    "    \"metadata\": {\"invocationId\": \"${CI_PROJECT_URL}/-/pipelines/${CI_PIPELINE_ID}#job-${provenance_build_job_id}\"}" \
    '  }' \
    '}' \
    > "${provenance_path}"
}
