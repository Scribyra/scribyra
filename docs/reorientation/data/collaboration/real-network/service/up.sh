#!/usr/bin/env bash
# Uses browsers already in the machine's Nix store, so nothing new is downloaded.
K="-i $HOME/.ssh/field_test_key -o IdentitiesOnly=yes -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30"
exec ssh $K -L $2:127.0.0.1:$2 -L $3:127.0.0.1:$3 -R 18765:127.0.0.1:8771 -R 18787:127.0.0.1:18787 <user>@$1 'f() { ls -d /nix/store/*-$1 2>/dev/null | head -1; }; PATH=$(f firefox-159.0.1)/bin:$(f geckodriver-0.37.1)/bin:$(f chromium-156.0.8078.79)/bin:$(f chromedriver-unwrapped-156.0.8078.79)/bin:$PATH; export PATH; command -v firefox geckodriver chromium chromedriver >&2; geckodriver --port '$2' --log fatal --allow-hosts 127.0.0.1 & chromedriver --port='$3' --silent & wait'
