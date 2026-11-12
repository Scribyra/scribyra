#!/usr/bin/env bash
K="-i $HOME/.ssh/field_test_key -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10"
for h in nixos machine-b; do ssh $K <user>@$h.<mesh> 'for p in $(ps -eo pid=,args= | awk "/geckodriver --port|chromedriver --port|-marionette|\.org\.chromium\.Chromium|rust_mozprofile/ && !/awk/ {print \$1}"); do kill $p 2>/dev/null; done; sleep 2; echo "$(hostname): left=$(ps -eo comm= | grep -cE "^(geckodriver|chromedriver)$")"'; done
