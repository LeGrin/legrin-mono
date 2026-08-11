#!/usr/bin/env bash
set -Eeuo pipefail

readonly app_name='legrin-finance-pipeline'
readonly deploy_root='/opt/legrin-finance-pipeline'
readonly shared_dir="${deploy_root}/shared"
readonly releases_dir="${deploy_root}/releases"
readonly env_file="${shared_dir}/.env"
readonly data_dir="${shared_dir}/data"
readonly secrets_dir="${shared_dir}/secrets"
readonly rollback_name="${app_name}-rollback"
readonly kitt_skill_dir='/opt/kingdom_v2/instances/kitt/skills/kitt/finance-tracker'

fail() {
  printf 'deploy_error=%s\n' "$1" >&2
  exit 1
}

[[ ${EUID} -eq 0 ]] || fail 'must_run_as_root'
[[ $# -eq 1 ]] || fail 'usage_sha_required'
readonly revision="$1"
[[ ${revision} =~ ^[0-9a-f]{40}$ ]] || fail 'invalid_revision'
[[ -f ${env_file} ]] || fail 'missing_runtime_env'

exec 9>"${deploy_root}/deploy.lock"
flock -n 9 || fail 'deployment_already_running'

mkdir -p "${releases_dir}" "${data_dir}" "${secrets_dir}"
chmod 700 "${shared_dir}" "${secrets_dir}"
chown -R 1000:1000 "${data_dir}"

archive_file="$(mktemp "${deploy_root}/archive.XXXXXX.tar.gz")"
new_release="${releases_dir}/${revision}"
new_image="${app_name}:${revision}"
deployment_succeeded=false

cleanup() {
  rm -f "${archive_file}"
  if [[ ${deployment_succeeded} != true && -d ${new_release} ]]; then
    rm -rf "${new_release}"
  fi
}
trap cleanup EXIT

cat >"${archive_file}"
tar -tzf "${archive_file}" | grep -Eq '(^/|(^|/)\.\.(/|$))' && fail 'unsafe_archive_path'
rm -rf "${new_release}"
mkdir -p "${new_release}"
tar -xzf "${archive_file}" -C "${new_release}" --no-same-owner --no-same-permissions

docker build --tag "${new_image}" "${new_release}"

had_previous=false
if docker container inspect "${app_name}" >/dev/null 2>&1; then
  had_previous=true
  docker rm -f "${rollback_name}" >/dev/null 2>&1 || true
  docker stop --time 20 "${app_name}" >/dev/null
  docker rename "${app_name}" "${rollback_name}"
fi

rollback() {
  docker rm -f "${app_name}" >/dev/null 2>&1 || true
  if [[ ${had_previous} == true ]] && docker container inspect "${rollback_name}" >/dev/null 2>&1; then
    docker rename "${rollback_name}" "${app_name}"
    docker start "${app_name}" >/dev/null
  fi
}

if ! docker run --detach \
  --name "${app_name}" \
  --restart unless-stopped \
  --network legrin_default \
  --publish 127.0.0.1:18088:8088 \
  --env-file "${env_file}" \
  --volume "${data_dir}:/app/data" \
  --volume "${secrets_dir}:/run/secrets:ro" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --log-driver json-file \
  --log-opt max-size=10m \
  --log-opt max-file=5 \
  --label "io.legrin.finance.revision=${revision}" \
  "${new_image}" >/dev/null; then
  rollback
  fail 'container_start_failed'
fi

if ! docker network connect legrin-network "${app_name}"; then
  rollback
  fail 'proxy_network_connect_failed'
fi

healthy=false
for _ in $(seq 1 90); do
  if docker exec "${app_name}" node -e \
    "fetch('http://127.0.0.1:8088/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"; then
    healthy=true
    break
  fi
  container_state="$(docker inspect --format '{{.State.Status}}' "${app_name}" 2>/dev/null || true)"
  if [[ ${container_state} == exited || ${container_state} == dead || ${container_state} == restarting ]]; then
    break
  fi
  sleep 2
done

if [[ ${healthy} != true ]]; then
  docker logs --tail 100 "${app_name}" >&2 || true
  rollback
  fail 'healthcheck_failed_rollback_completed'
fi

kitt_skill_source="${new_release}/integrations/kitt/finance-tracker/SKILL.md"
if [[ ! -f ${kitt_skill_source} ]]; then
  rollback
  fail 'missing_kitt_finance_skill'
fi
if ! install -d -m 0755 "${kitt_skill_dir}" \
  || ! install -m 0644 "${kitt_skill_source}" "${kitt_skill_dir}/SKILL.md"; then
  rollback
  fail 'kitt_skill_deploy_failed'
fi

docker rm -f "${rollback_name}" >/dev/null 2>&1 || true
ln -sfn "${new_release}" "${deploy_root}/current"
deployment_succeeded=true

mapfile -t stale_releases < <(
  find "${releases_dir}" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
    | sort -nr \
    | tail -n +6 \
    | cut -d' ' -f2-
)
for stale_release in "${stale_releases[@]}"; do
  rm -rf "${stale_release}"
done

printf 'deployed_revision=%s container=%s health=ok\n' "${revision}" "${app_name}"
