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

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Alignyard Runner currently supports macOS only." >&2
  exit 1
fi
if [ -z "$platform" ] || [ -z "$code" ]; then
  echo "Usage: install-runner-macos.sh --platform <url> --code <pairing-code>" >&2
  exit 2
fi

case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) echo "Unsupported Mac architecture: $(uname -m)" >&2; exit 1 ;;
esac

temporary=$(mktemp -d "${TMPDIR:-/tmp}/alignyard-runner.XXXXXX")
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
base="${platform%/}/downloads/runner/stable/darwin-${arch}"

echo "Downloading Alignyard Runner for darwin-${arch}..."
curl -fsSL "$base/alignyard-runner.tar.gz" -o "$temporary/alignyard-runner.tar.gz"
curl -fsSL "$base/alignyard-runner.tar.gz.sha256" -o "$temporary/alignyard-runner.tar.gz.sha256"
(
  cd "$temporary"
  shasum -a 256 -c alignyard-runner.tar.gz.sha256
  tar -xzf alignyard-runner.tar.gz
)

"$temporary/alignyard-runner/install.sh" --platform "$platform" --code "$code"
