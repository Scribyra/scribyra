#!/usr/bin/env bash
T=<agents>/trials/real-wifi; cd $T
python3 -m http.server 8770 --bind 127.0.0.1 --directory www >/dev/null 2>&1 & W=$!
./up2.sh nixos.<mesh> 9411 9412 > a2.log 2>&1 & UA=$!
./up2.sh machine-b.<mesh> 9421 9422 > b2.log 2>&1 & UB=$!
for i in $(seq 1 100); do curl -s -m2 http://127.0.0.1:9411/status >/dev/null && curl -s -m2 http://127.0.0.1:9412/status >/dev/null && curl -s -m2 http://127.0.0.1:9421/status >/dev/null && curl -s -m2 http://127.0.0.1:9422/status >/dev/null && break; sleep 5; done
nix-shell -I nixpkgs=channel:nixpkgs-unstable -p nodejs --run "node drive2.mjs $1 $2" 2>&1 | cut -c1-260
kill $UA $UB $W 2>/dev/null; sleep 2; ./clean2.sh
