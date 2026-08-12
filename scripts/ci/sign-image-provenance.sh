#!/bin/sh
set -eu

. "${CI_PROJECT_DIR:-.}/scripts/ci/image-provenance-common.sh"

validate_ci_identity
validate_registry_ca
require_nonempty COSIGN_PASSWORD "${COSIGN_PASSWORD:-}"
require_pem_file \
  COSIGN_PRIVATE_KEY_FILE \
  "${COSIGN_PRIVATE_KEY_FILE:-}" \
  '-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----' \
  '-----END ENCRYPTED SIGSTORE PRIVATE KEY-----'
require_pem_file \
  COSIGN_PUBLIC_KEY_FILE \
  "${COSIGN_PUBLIC_KEY_FILE:-}" \
  '-----BEGIN PUBLIC KEY-----' \
  '-----END PUBLIC KEY-----'

derived_public_key="$(mktemp "${CI_PROJECT_DIR:-.}/.cosign-public.XXXXXX")"
trap 'rm -f "${derived_public_key}"' EXIT HUP INT TERM
cosign public-key \
  --key "${COSIGN_PRIVATE_KEY_FILE}" \
  --outfile "${derived_public_key}" \
  >/dev/null
cmp -s "${derived_public_key}" "${COSIGN_PUBLIC_KEY_FILE}" \
  || provenance_fail "COSIGN_PUBLIC_KEY_FILE does not match COSIGN_PRIVATE_KEY_FILE"

build_job_ids=''
for image_name in api web; do
  load_image_evidence "${image_name}"
  case " ${build_job_ids} " in
    *" ${EVIDENCE_BUILD_JOB_ID} "*) provenance_fail "api and web must originate from distinct build jobs" ;;
  esac
  build_job_ids="${build_job_ids} ${EVIDENCE_BUILD_JOB_ID}"

  case "${image_name}" in
    api) dockerfile_path='Dockerfile.api' ;;
    web) dockerfile_path='Dockerfile.web' ;;
  esac
  provenance_path="${image_name}.provenance.json"
  write_slsa_provenance \
    "${image_name}" \
    "${dockerfile_path}" \
    "${EVIDENCE_DIGEST}" \
    "${EVIDENCE_BUILD_JOB_ID}" \
    "${provenance_path}"

  COSIGN_EXPERIMENTAL=1 cosign_registry sign \
    --yes \
    --key "${COSIGN_PRIVATE_KEY_FILE}" \
    --use-signing-config=false \
    --tlog-upload=false \
    --registry-referrers-mode oci-1-1 \
    --registry-username "${CI_REGISTRY_USER}" \
    --registry-password "${CI_REGISTRY_PASSWORD}" \
    -a "sourceProject=${CI_PROJECT_PATH}" \
    -a "sourceRevision=${CI_COMMIT_SHA}" \
    -a "pipelineId=${CI_PIPELINE_ID}" \
    -a "buildJobId=${EVIDENCE_BUILD_JOB_ID}" \
    -a "imageName=${image_name}" \
    -a "builderImage=${KANIKO_BUILDER_IMAGE}" \
    "${EVIDENCE_IMAGE}"

  cosign_registry attest \
    --yes \
    --key "${COSIGN_PRIVATE_KEY_FILE}" \
    --use-signing-config=false \
    --tlog-upload=false \
    --predicate "${provenance_path}" \
    --type slsaprovenance1 \
    --registry-username "${CI_REGISTRY_USER}" \
    --registry-password "${CI_REGISTRY_PASSWORD}" \
    "${EVIDENCE_IMAGE}"

  printf 'Signed image and SLSA provenance: %s\n' "${EVIDENCE_IMAGE}"
done
