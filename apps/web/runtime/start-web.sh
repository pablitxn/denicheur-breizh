#!/bin/sh

set -eu

readonly config_path="/opt/denicheur/nginx.conf"
readonly runtime_directory="/tmp/denicheur"
readonly runtime_include="${runtime_directory}/proxy-runtime.conf"
readonly auth_runtime_include="${runtime_directory}/gateway-auth-runtime.conf"

fail() {
  printf 'denicheur-web: %s\n' "$1" >&2
  exit 1
}

upstream=${WEB_API_UPSTREAM:-}
token_file=${WEB_OPERATOR_TOKEN_FILE:-}
gateway_token_file=${WEB_GATEWAY_AUTH_TOKEN_FILE:-}

[ -n "$upstream" ] || fail "WEB_API_UPSTREAM is required (for example http://api:4310)."
[ "${#upstream}" -le 512 ] || fail "WEB_API_UPSTREAM is too long."

case "$upstream" in
  http://*) authority=${upstream#http://} ;;
  https://*) authority=${upstream#https://} ;;
  *) fail "WEB_API_UPSTREAM must use http:// or https://." ;;
esac

case "$authority" in
  ""|*[!A-Za-z0-9.:-]*) fail "WEB_API_UPSTREAM must contain only a hostname and optional port." ;;
esac

case "$authority" in
  *:*)
    host=${authority%:*}
    port=${authority##*:}
    case "$host" in *:*) fail "IPv6 upstream literals are not supported; use a DNS name." ;; esac
    case "$port" in ""|*[!0-9]*) fail "WEB_API_UPSTREAM has an invalid port." ;; esac
    [ "${#port}" -le 5 ] || fail "WEB_API_UPSTREAM has an invalid port."
    [ "$port" -ge 1 ] 2>/dev/null && [ "$port" -le 65535 ] 2>/dev/null \
      || fail "WEB_API_UPSTREAM port must be between 1 and 65535."
    ;;
  *) host=$authority ;;
esac

case "$host" in
  ""|.*|*.|-*|*-|*..*) fail "WEB_API_UPSTREAM has an invalid hostname." ;;
  *[!A-Za-z0-9.-]*) fail "WEB_API_UPSTREAM has an invalid hostname." ;;
esac

[ -n "$token_file" ] || fail "WEB_OPERATOR_TOKEN_FILE is required."
case "$token_file" in
  /*) ;;
  *) fail "WEB_OPERATOR_TOKEN_FILE must be an absolute path." ;;
esac
case "$token_file" in
  *[!A-Za-z0-9_./-]*) fail "WEB_OPERATOR_TOKEN_FILE contains unsupported characters." ;;
esac
[ -f "$token_file" ] && [ -r "$token_file" ] || fail "WEB_OPERATOR_TOKEN_FILE must be a readable regular file."

token=$(cat "$token_file")
[ "${#token}" -ge 32 ] && [ "${#token}" -le 512 ] \
  || fail "The operator token must contain between 32 and 512 characters."
case "$token" in
  *[!A-Za-z0-9._~+/=-]*) fail "The operator token must use the RFC 6750 bearer-token character set." ;;
esac

[ -n "$gateway_token_file" ] || fail "WEB_GATEWAY_AUTH_TOKEN_FILE is required."
case "$gateway_token_file" in
  /*) ;;
  *) fail "WEB_GATEWAY_AUTH_TOKEN_FILE must be an absolute path." ;;
esac
case "$gateway_token_file" in
  *[!A-Za-z0-9_./-]*) fail "WEB_GATEWAY_AUTH_TOKEN_FILE contains unsupported characters." ;;
esac
[ "$gateway_token_file" != "$token_file" ] \
  || fail "WEB_GATEWAY_AUTH_TOKEN_FILE must be different from WEB_OPERATOR_TOKEN_FILE."
[ -f "$gateway_token_file" ] && [ -r "$gateway_token_file" ] \
  || fail "WEB_GATEWAY_AUTH_TOKEN_FILE must be a readable regular file."

gateway_token=$(cat "$gateway_token_file")
[ "${#gateway_token}" -ge 32 ] && [ "${#gateway_token}" -le 512 ] \
  || fail "The gateway auth token must contain between 32 and 512 characters."
case "$gateway_token" in
  *[!A-Za-z0-9_-]*) fail "The gateway auth token must use unpadded base64url characters." ;;
esac
[ "$gateway_token" != "$token" ] \
  || fail "The gateway auth token must be different from the operator token."

umask 077
mkdir -p "$runtime_directory"
: > "$auth_runtime_include"
printf 'map $uri $denicheur_public_path {\n  default 0;\n  ~^/healthz$ 1;\n}\n' \
  >> "$auth_runtime_include"
printf 'map $http_x_denicheur_ingress_token $denicheur_ingress_token_valid {\n  default 0;\n  ~^%s$ 1;\n}\n' \
  "$gateway_token" >> "$auth_runtime_include"
printf 'map "$denicheur_public_path:$denicheur_ingress_token_valid" $denicheur_gateway_access_denied {\n  default 1;\n  "1:0" 0;\n  "1:1" 0;\n  "0:1" 0;\n}\n' \
  >> "$auth_runtime_include"
: > "$runtime_include"
printf 'proxy_pass %s/;\n' "$upstream" >> "$runtime_include"
printf 'proxy_set_header Authorization "Bearer %s";\n' "$token" >> "$runtime_include"

case "$upstream" in
  https://*)
    ca_file=${WEB_API_CA_FILE:-/etc/ssl/certs/ca-certificates.crt}
    case "$ca_file" in
      /*) ;;
      *) fail "WEB_API_CA_FILE must be an absolute path." ;;
    esac
    case "$ca_file" in
      *[!A-Za-z0-9_./-]*) fail "WEB_API_CA_FILE contains unsupported characters." ;;
    esac
    [ -f "$ca_file" ] && [ -r "$ca_file" ] || fail "WEB_API_CA_FILE must be a readable CA bundle for HTTPS upstreams."
    printf 'proxy_ssl_server_name on;\n' >> "$runtime_include"
    printf 'proxy_ssl_verify on;\n' >> "$runtime_include"
    printf 'proxy_ssl_trusted_certificate %s;\n' "$ca_file" >> "$runtime_include"
    ;;
esac

chmod 0600 "$auth_runtime_include" "$runtime_include"
unset token gateway_token upstream token_file gateway_token_file authority host port ca_file \
  WEB_API_UPSTREAM WEB_OPERATOR_TOKEN_FILE WEB_GATEWAY_AUTH_TOKEN_FILE WEB_API_CA_FILE

nginx -t -c "$config_path"

if [ "${1:-}" = "--check" ]; then
  exit 0
fi
[ "$#" -eq 0 ] || fail "unsupported entrypoint arguments."

exec nginx -c "$config_path" -g 'daemon off;'
