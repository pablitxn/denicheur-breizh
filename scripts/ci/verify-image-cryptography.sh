#!/bin/sh
set -eu

. "${CI_PROJECT_DIR:-.}/scripts/ci/image-provenance-common.sh"

validate_ci_identity
validate_registry_ca
[ -z "${COSIGN_PRIVATE_KEY_FILE:-}" ] && [ -z "${COSIGN_PASSWORD:-}" ] \
  || provenance_fail "private signing variables must be scoped only to the cosign-signing environment"
require_pem_file \
  COSIGN_PUBLIC_KEY_FILE \
  "${COSIGN_PUBLIC_KEY_FILE:-}" \
  '-----BEGIN PUBLIC KEY-----' \
  '-----END PUBLIC KEY-----'

build_job_ids=''
for image_name in api web; do
  load_image_evidence "${image_name}"
  case " ${build_job_ids} " in
    *" ${EVIDENCE_BUILD_JOB_ID} "*) provenance_fail "api and web must originate from distinct build jobs" ;;
  esac
  build_job_ids="${build_job_ids} ${EVIDENCE_BUILD_JOB_ID}"

  [ -f "${image_name}.provenance.json" ] && [ -s "${image_name}.provenance.json" ] \
    || provenance_fail "${image_name}: signed provenance predicate artifact is missing"

  cosign_registry verify \
    --output json \
    --key "${COSIGN_PUBLIC_KEY_FILE}" \
    --private-infrastructure \
    --registry-username "${CI_REGISTRY_USER}" \
    --registry-password "${CI_REGISTRY_PASSWORD}" \
    -a "sourceProject=${CI_PROJECT_PATH}" \
    -a "sourceRevision=${CI_COMMIT_SHA}" \
    -a "pipelineId=${CI_PIPELINE_ID}" \
    -a "buildJobId=${EVIDENCE_BUILD_JOB_ID}" \
    -a "imageName=${image_name}" \
    -a "builderImage=${KANIKO_BUILDER_IMAGE}" \
    "${EVIDENCE_IMAGE}" \
    > "${image_name}.signature-verification.json"

  cosign_registry verify-attestation \
    --output json \
    --key "${COSIGN_PUBLIC_KEY_FILE}" \
    --private-infrastructure \
    --type slsaprovenance1 \
    --registry-username "${CI_REGISTRY_USER}" \
    --registry-password "${CI_REGISTRY_PASSWORD}" \
    "${EVIDENCE_IMAGE}" \
    > "${image_name}.attestation-verification.json"

  [ -s "${image_name}.signature-verification.json" ] \
    || provenance_fail "${image_name}: Cosign returned no verified signature payload"
  [ -s "${image_name}.attestation-verification.json" ] \
    || provenance_fail "${image_name}: Cosign returned no verified attestation payload"
  printf 'Cryptographically verified registry image: %s\n' "${EVIDENCE_IMAGE}"
done
