#!/bin/sh
set -eu

repository=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
case "$(uname -m)" in
  arm64) artifact_arch=arm64; node_arch=arm64 ;;
  x86_64) artifact_arch=x64; node_arch=x64 ;;
  *) echo "Unsupported Mac architecture: $(uname -m)" >&2; exit 1 ;;
esac

version=$(tr -d '\r\n' < "$repository/server/runner/VERSION")
case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "Invalid Runner version: $version" >&2; exit 1 ;;
esac
node_version=${ALIGNYARD_NODE_VERSION:-$(node -p "process.versions.node")}
output=${ALIGNYARD_RUNNER_ARTIFACT_DIR:-"$repository/dist/runner"}
target="$output/stable/darwin-$artifact_arch"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/alignyard-runner-build.XXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
package="$temporary/alignyard-runner"
archive="$target/alignyard-runner.tar.gz"
manifest="$target/manifest.json"

source_index="$temporary/source-index"
find \
  "$repository/server/core" \
  "$repository/server/repo" \
  "$repository/server/task" \
  "$repository/server/session" \
  "$repository/server/protocol" \
  "$repository/server/runner" \
  "$repository/scripts/runner-package" \
  -type f ! -name '*.test.ts' -print | LC_ALL=C sort > "$source_index.paths"
printf '%s\n' \
  "$repository/package.json" \
  "$repository/package-lock.json" \
  "$repository/server/ay.ts" \
  "$repository/server/platform/forge.ts" \
  "$repository/scripts/build-runner-macos.sh" >> "$source_index.paths"
LC_ALL=C sort -u "$source_index.paths" | while IFS= read -r source; do
  relative=${source#"$repository/"}
  sha=$(shasum -a 256 "$source" | awk '{print $1}')
  printf '%s  %s\n' "$sha" "$relative"
done > "$source_index"
source_sha=$(shasum -a 256 "$source_index" | awk '{print $1}')

if [ -f "$archive" ] && [ -f "$manifest" ]; then
  cached_version=$(sed -n 's/.*"version":"\([^"]*\)".*/\1/p' "$manifest")
  cached_source_sha=$(sed -n 's/.*"source_sha256":"\([^"]*\)".*/\1/p' "$manifest")
  cached_archive_sha=$(sed -n 's/.*"sha256":"\([^"]*\)".*/\1/p' "$manifest")
  actual_archive_sha=$(shasum -a 256 "$archive" | awk '{print $1}')
  if [ "$cached_version" = "$version" ] \
    && [ -n "$cached_source_sha" ] \
    && [ "$cached_source_sha" != "$source_sha" ]; then
    echo "Runner sources changed without a version bump (current: $version)" >&2
    exit 2
  fi
  if [ "$cached_version" = "$version" ] \
    && [ "$cached_source_sha" = "$source_sha" ] \
    && [ "$cached_archive_sha" = "$actual_archive_sha" ]; then
    echo "Reusing cached Alignyard Runner $version ($source_sha)"
    echo "$archive"
    exit 0
  fi
fi

mkdir -p "$package/app/server/platform" "$package/bin" "$package/runtime" "$target"
for directory in core repo task session protocol runner; do
  cp -R "$repository/server/$directory" "$package/app/server/$directory"
done
cp "$repository/server/ay.ts" "$package/app/server/ay.ts"
cp "$repository/server/platform/forge.ts" "$package/app/server/platform/forge.ts"
find "$package/app/server" -type f -name '*.test.ts' -delete
cp "$repository/package.json" "$repository/package-lock.json" "$package/app/"
(
  cd "$package/app"
  npm ci --include=dev --no-audit --no-fund
)

node_archive="node-v${node_version}-darwin-${node_arch}.tar.gz"
cache_root=${ALIGNYARD_RUNNER_BUILD_CACHE_DIR:-"${XDG_CACHE_HOME:-${HOME:-$temporary}/.cache}/alignyard/runner-build"}
cached_node_archive="$cache_root/$node_archive"
mkdir -p "$cache_root"
if [ ! -s "$cached_node_archive" ] || ! tar -tzf "$cached_node_archive" >/dev/null 2>&1; then
  download="$temporary/$node_archive.download"
  curl -fsSL "https://nodejs.org/dist/v${node_version}/${node_archive}" -o "$download"
  mv "$download" "$cached_node_archive"
fi
tar -xzf "$cached_node_archive" -C "$temporary"
cp "$temporary/node-v${node_version}-darwin-${node_arch}/bin/node" "$package/runtime/node"
chmod 755 "$package/runtime/node"
printf '%s\n' "$version" > "$package/VERSION"

cp "$repository/scripts/runner-package/alignyard-runner" "$package/bin/alignyard-runner"
cp "$repository/scripts/runner-package/ay" "$package/bin/ay"
cp "$repository/scripts/runner-package/install.sh" "$package/install.sh"
chmod 755 "$package/bin/alignyard-runner" "$package/bin/ay" "$package/install.sh"

tar -czf "$archive" -C "$temporary" alignyard-runner
(
  cd "$target"
  shasum -a 256 alignyard-runner.tar.gz > alignyard-runner.tar.gz.sha256
)
size=$(stat -f %z "$archive")
sha=$(shasum -a 256 "$archive" | awk '{print $1}')
printf '{"version":"%s","node_version":"%s","os":"darwin","arch":"%s","size":%s,"sha256":"%s","source_sha256":"%s"}\n' \
  "$version" "$node_version" "$artifact_arch" "$size" "$sha" "$source_sha" > "$manifest"
echo "$archive"
