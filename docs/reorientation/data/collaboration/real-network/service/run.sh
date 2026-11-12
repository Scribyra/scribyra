#!/usr/bin/env bash
T=<agents>/trials/service-wifi; cd $T
B=$(python3 -c 'import secrets;print(secrets.token_hex(32))'); H=$(printf %s "$B" | sha256sum | cut -d' ' -f1); N=$(python3 -c 'import secrets;print(secrets.token_hex(32))'); D=$(mktemp -d $T/data.XXXX)
printf '{"bind":"127.0.0.1:18787","data":"%s","origins":["http://127.0.0.1:18765"],"principals":[{"token_hash":"%s","namespace":"%s","storage":false,"relay":true}]}' "$D/d" "$H" "$N" > $D/c.json
SCRIBYRA_SERVICE_CONFIG=$D/c.json <repo>/target/release/scribyra-sync > service.log 2>&1 & S=$!
python3 -m http.server 8771 --bind 127.0.0.1 --directory www >/dev/null 2>&1 & W=$!
./up.sh nixos.<mesh> 9411 9412 > a.log 2>&1 & UA=$!
./up.sh machine-b.<mesh> 9421 9422 > b.log 2>&1 & UB=$!
for i in $(seq 1 200); do curl -s -m2 http://127.0.0.1:9411/status >/dev/null && curl -s -m2 http://127.0.0.1:9412/status >/dev/null && curl -s -m2 http://127.0.0.1:9421/status >/dev/null && curl -s -m2 http://127.0.0.1:9422/status >/dev/null && break; sleep 4; done
nix-shell -I nixpkgs=channel:nixpkgs-unstable -p nodejs --run "node drive.mjs $1 $B ${2:-2}" 2>&1 | cut -c1-330
kill $UA $UB $W $S 2>/dev/null; sleep 2; rm -rf $D; <agents>/trials/real-wifi/clean2.sh 2>&1 | tail -2
