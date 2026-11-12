#!/usr/bin/env bash
# usage: up2.sh <host> <geckoLocal> <chromeLocal> ; headless browser drivers on a real machine, forwarded over SSH.
K="-i $HOME/.ssh/field_test_key -o IdentitiesOnly=yes -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30"
exec ssh $K -L $2:127.0.0.1:$2 -L $3:127.0.0.1:$3 -R 18765:127.0.0.1:8770 <user>@$1 'nix-shell -I nixpkgs=channel:nixpkgs-unstable -p firefox geckodriver chromium chromedriver --run "geckodriver --port '$2' --log fatal --allow-hosts 127.0.0.1 & chromedriver --port='$3' --silent & wait"'
