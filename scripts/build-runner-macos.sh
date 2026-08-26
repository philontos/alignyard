#!/bin/sh
set -eu

repository=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
case "$(uname -m)" in
  arm64) artifact_arch=arm64; node_arch=arm64 ;;
  x86_64) artifact_arch=x64; node_arch=x64 ;;
  *) echo "Unsupported Mac architecture: $(uname -m)" >&2; exit 1 ;;
esac

version=$(node -p "require('$repository/package.json').version")
node_version=${ALIGNYARD_NODE_VERSION:-$(node -p "process.versions.node")}
output=${ALIGNYARD_RUNNER_ARTIFACT_DIR:-"$repository/dist/runner"}
target="$output/stable/darwin-$artifact_arch"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/alignyard-runner-build.XXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
package="$temporary/alignyard-runner"

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
curl -fsSL "https://nodejs.org/dist/v${node_version}/${node_archive}" -o "$temporary/$node_archive"
tar -xzf "$temporary/$node_archive" -C "$temporary"
cp "$temporary/node-v${node_version}-darwin-${node_arch}/bin/node" "$package/runtime/node"
chmod 755 "$package/runtime/node"
printf '%s\n' "$version" > "$package/VERSION"

cp "$repository/scripts/runner-package/alignyard-runner" "$package/bin/alignyard-runner"
cp "$repository/scripts/runner-package/ay" "$package/bin/ay"
cp "$repository/scripts/runner-package/install.sh" "$package/install.sh"
chmod 755 "$package/bin/alignyard-runner" "$package/bin/ay" "$package/install.sh"

archive="$target/alignyard-runner.tar.gz"
tar -czf "$archive" -C "$temporary" alignyard-runner
(
  cd "$target"
  shasum -a 256 alignyard-runner.tar.gz > alignyard-runner.tar.gz.sha256
)
size=$(stat -f %z "$archive")
sha=$(shasum -a 256 "$archive" | awk '{print $1}')
printf '{"version":"%s","node_version":"%s","os":"darwin","arch":"%s","size":%s,"sha256":"%s"}\n' \
  "$version" "$node_version" "$artifact_arch" "$size" "$sha" > "$target/manifest.json"
echo "$archive"
