#!/usr/bin/env bash
# Opt-in end-to-end test of organisation sign-in against a real Zitadel (docs/service.md,
# "Testing with a real Zitadel"): builds Zitadel from the flake's nixpkgs and the service, then
# runs tests/browser/org-zitadel.spec.js with SCRIBYRA_ZITADEL_E2E=1. Zitadel, its PostgreSQL
# and every service run on loopback ports in tmp/ and stop with the test. Needs a built app
# (`npm run build`, served by Playwright's preview server) and web/pkg (`npm run wasm`).
#   scripts/zitadel-e2e.sh [chromium|firefox|webkit ...] [-- extra Playwright arguments]
set -euo pipefail
cd "$(dirname "$0")/.."
projects=()
while [ $# -gt 0 ] && [ "$1" != "--" ]; do projects+=("--project=$1"); shift; done
[ "${1:-}" = "--" ] && shift
[ ${#projects[@]} -eq 0 ] && projects=(--project=chromium)
zitadel=$(nix build --inputs-from . nixpkgs#zitadel --no-link --print-out-paths)
"$zitadel/bin/zitadel" --version >/dev/null
export SCRIBYRA_ZITADEL="$zitadel/bin/zitadel" SCRIBYRA_ZITADEL_E2E=1
nix develop -c cargo build -p scribyra-sync --bins
# WebKit on hosts without a GPU needs a software renderer (as for the other browser specs);
# pass it through the environment, for example
# __EGL_VENDOR_LIBRARY_FILENAMES=…/50_mesa.json LIBGL_ALWAYS_SOFTWARE=1.
exec nix develop -c npx playwright test tests/browser/org-zitadel.spec.js "${projects[@]}" "$@"
