#!/usr/bin/env python3
"""Install pinned CI build tools without compiling a second toolchain/CLI."""
import hashlib
import os
import platform
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

root=Path(__file__).resolve().parent.parent
if platform.system()!='Linux' or platform.machine() not in ['x86_64','amd64']:raise SystemExit('Pinned CI toolchain requires Linux/amd64')
cache=root/'.cache/ci-tools';cache.mkdir(parents=True,exist_ok=True)
if shutil.disk_usage(root).free<4*1024**3:raise SystemExit('CI build requires at least 4 GiB free')
def fetch(url,digest,size,path):
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest()==digest:return
    with urllib.request.urlopen(url,timeout=60) as response,path.open('wb') as output:
        value=hashlib.sha256();count=0
        for block in iter(lambda:response.read(1024*1024),b''):
            count+=len(block)
            if count>size:raise SystemExit('CI tool exceeds pinned download budget')
            value.update(block);output.write(block)
    if count!=size or value.hexdigest()!=digest:raise SystemExit('CI tool checksum/size mismatch')

rustup=cache/'rustup-init-1.29.3'
fetch('https://static.rust-lang.org/rustup/archive/1.29.3/x86_64-unknown-linux-gnu/rustup-init','b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55',21347088,rustup)
rustup.chmod(0o755)
cargo=Path(os.environ['CARGO_HOME']);rustup_bin=cargo/'bin/rustup'
if not rustup_bin.is_file():subprocess.run([str(rustup),'-y','--no-modify-path','--profile','minimal','--default-toolchain','1.99.1'],check=True)
subprocess.run([str(rustup_bin),'toolchain','install','1.99.1','--profile','minimal','--target','wasm32-unknown-unknown'],check=True)
subprocess.run([str(rustup_bin),'default','1.99.1'],check=True)
destination=cache/'bin/wasm-bindgen';destination.parent.mkdir(exist_ok=True)
digest_file=cache/'wasm-bindgen.sha256'
if destination.exists() and digest_file.exists() and hashlib.sha256(destination.read_bytes()).hexdigest()==digest_file.read_text().strip():
    raise SystemExit(0)
with tempfile.TemporaryDirectory(dir=cache) as temporary:
    archive=Path(temporary)/'wasm-bindgen.tar.gz'
    fetch('https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.129/wasm-bindgen-0.2.129-x86_64-unknown-linux-musl.tar.gz','82d12bb940e2d4e72e0d5605387fc1b8ca179044e012b620f0ce4e7440e8320e',11695824,archive)
    with tarfile.open(archive,'r:gz') as bundle:
        entry=bundle.getmember('wasm-bindgen-0.2.129-x86_64-unknown-linux-musl/wasm-bindgen')
        if not entry.isfile() or entry.size>100*1024*1024:raise SystemExit('Invalid wasm-bindgen member')
        with bundle.extractfile(entry) as source,destination.open('wb') as output:shutil.copyfileobj(source,output)
    destination.chmod(0o755)
    digest_file.write_text(hashlib.sha256(destination.read_bytes()).hexdigest()+'\n')
