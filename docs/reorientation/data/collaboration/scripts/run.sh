#!/usr/bin/env bash
# usage: run.sh <test.mjs> [args]  - runs inside dev shell and a fresh unprivileged user+net namespace
S=$(dirname "$(readlink -f "$0")")
cd <repo> && exec nix develop -c unshare -Urn --kill-child node "$S/$1" "${@:2}"
