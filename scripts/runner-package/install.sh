#!/bin/sh
set -eu

platform=""
code=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --platform) platform=${2:-}; shift 2 ;;
    --code) code=${2:-}; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$platform" ] || [ -z "$code" ]; then
  echo "Missing --platform or --code" >&2
  exit 2
fi

package=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
version=$(tr -d '\r\n' < "$package/VERSION")
install_root="$HOME/.alignyard/app/$version"
bin_dir="$HOME/.local/bin"
mkdir -p "$install_root" "$bin_dir"
cp -R "$package/." "$install_root/"
ln -sfn "$install_root/bin/alignyard-runner" "$bin_dir/alignyard-runner"
ln -sfn "$install_root/bin/ay" "$bin_dir/ay"

echo "Installing Alignyard Runner $version..."
if [ -f "${ALIGNYARD_RUNNER_CONFIG:-$HOME/.alignyard/runner.json}" ]; then
  echo "Existing Runner configuration found; keeping its pairing."
  ALIGNYARD_RUNNER_BIN="$bin_dir/alignyard-runner" \
    "$bin_dir/alignyard-runner" service-install
else
  ALIGNYARD_RUNNER_BIN="$bin_dir/alignyard-runner" \
    "$bin_dir/alignyard-runner" install --platform "$platform" --code "$code"
fi
echo "Runner installed. Logs: $HOME/.alignyard/logs"
