#!/bin/sh
set -eu

repository=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
project=${ALIGNYARD_GCP_PROJECT:-p02-internal-services}
zone=${ALIGNYARD_GCP_ZONE:-asia-east1-b}
instance=${ALIGNYARD_GCP_INSTANCE:-alignyard-platform-1}
remote_root=${ALIGNYARD_GCP_REMOTE_ROOT:-/opt/alignyard}
revision=${ALIGNYARD_DEPLOY_REVISION:-$(git -C "$repository" rev-parse HEAD)}

case "$project:$zone:$instance" in
  *[!a-z0-9:-]*) echo "Invalid GCP deploy target" >&2; exit 2 ;;
esac
case "$revision" in
  *[!0-9a-f]*|'') echo "ALIGNYARD_DEPLOY_REVISION must be a Git commit SHA" >&2; exit 2 ;;
esac
case "$remote_root" in
  /opt/*) ;;
  *) echo "ALIGNYARD_GCP_REMOTE_ROOT must be below /opt" >&2; exit 2 ;;
esac
case "$remote_root" in
  *[!A-Za-z0-9_./-]*|*../*) echo "Invalid ALIGNYARD_GCP_REMOTE_ROOT" >&2; exit 2 ;;
esac

head_revision=$(git -C "$repository" rev-parse HEAD)
if [ "$revision" != "$head_revision" ]; then
  echo "Check out the requested revision before deploying it" >&2
  exit 2
fi
if [ -n "$(git -C "$repository" status --porcelain --untracked-files=normal)" ]; then
  echo "Commit or discard working tree changes before deployment" >&2
  exit 2
fi

runner_artifact="$repository/dist/runner/stable/darwin-arm64/alignyard-runner.tar.gz"
(cd "$repository" && npm run build:runner:macos)

temporary=$(mktemp -d "${TMPDIR:-/tmp}/alignyard-deploy.XXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
stage="$temporary/release"
bundle="$temporary/alignyard-$revision.tar.gz"
mkdir -p "$stage"
git -C "$repository" archive "$revision" | tar -x -C "$stage"
mkdir -p "$stage/dist"
cp -R "$repository/dist/runner" "$stage/dist/runner"
tar -czf "$bundle" -C "$stage" .

remote_bundle="/tmp/alignyard-$revision.tar.gz"
gcloud compute scp "$bundle" "$instance:$remote_bundle" \
  --project="$project" --zone="$zone" --quiet
gcloud compute ssh "$instance" --project="$project" --zone="$zone" --quiet --command="
set -eu
release='$remote_root/releases/$revision'
mkdir -p \"\$release\"
tar -xzf '$remote_bundle' -C \"\$release\"
ln -sfn '$remote_root/shared/.env' \"\$release/.env\"
cd \"\$release\"
sudo docker-compose -p alignyard -f compose.yaml -f compose.production.yaml build alignyard
sudo docker-compose -p alignyard -f compose.yaml -f compose.production.yaml up -d --remove-orphans
attempt=0
until curl -fsS http://127.0.0.1:4500/healthz >/dev/null; do
  attempt=\$((attempt + 1))
  if [ \"\$attempt\" -ge 30 ]; then
    sudo docker-compose -p alignyard -f compose.yaml -f compose.production.yaml logs --tail=120
    exit 1
  fi
  sleep 1
done
ln -sfn \"\$release\" '$remote_root/current'
rm -f '$remote_bundle'
sudo docker-compose -p alignyard -f compose.yaml -f compose.production.yaml ps
"

echo "Deployed $revision to $instance ($zone)"
