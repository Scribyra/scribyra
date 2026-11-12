#!/usr/bin/env python3
"""Fetch only explicitly requested, pinned observability tools; discard archives.
Uses the session's standard proxy/CA configuration. No credentials are handled.
"""
import hashlib, json, os, platform, shutil, sys, tempfile, urllib.request, zipfile, tarfile
from pathlib import Path
ROOT=Path(__file__).resolve().parent.parent
pins=json.loads((ROOT/'ops/telemetry/tools.lock.json').read_text())
name=sys.argv[1] if len(sys.argv)==2 else ''
if name not in pins: raise SystemExit('Choose one pinned tool: '+', '.join(pins))
if platform.system()!='Linux' or platform.machine() not in ('x86_64','amd64'):raise SystemExit('Pinned tool bootstrap currently supports Linux/amd64.')
pin=pins[name];cache=ROOT/'.cache/telemetry-tools';cache.mkdir(parents=True,exist_ok=True)
target=cache/(name+'-'+pin['version']);metadata=target.with_suffix('.json')
def sha(path):
    value=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):value.update(block)
    return value.hexdigest()
if target.exists() and metadata.exists():
    saved=json.loads(metadata.read_text())
    valid=saved.get('archiveSha256')==pin['sha256']
    if pin.get('directory'):
        files={str(p.relative_to(target)):p for p in target.rglob('*') if p.is_file()}
        valid=valid and bool(saved.get('files')) and set(files)==set(saved['files']) and all(not p.is_symlink() and sha(p)==saved['files'][key] for key,p in files.items())
    else:
        valid=valid and saved.get('executableSha256')==sha(target)
    if valid:
        print(target);raise SystemExit(0)
budget=(4 if pin.get('directory') else 2)*1024**3
if shutil.disk_usage(cache).free<budget:raise SystemExit('Insufficient space for tool download and extraction budget')
with tempfile.TemporaryDirectory(prefix=name+'-',dir=cache) as temporary:
    archive=Path(temporary)/'download.zip'
    downloaded=0
    with urllib.request.urlopen(pin['url'],timeout=60) as response,archive.open('wb') as output:
        for block in iter(lambda:response.read(1024*1024),b''):
            downloaded+=len(block)
            if downloaded>pin['archiveBytes']:raise SystemExit('Tool archive exceeds pinned byte budget')
            output.write(block)
    if downloaded!=pin['archiveBytes']:raise SystemExit('Tool archive size differs from pin')
    if sha(archive)!=pin['sha256']:raise SystemExit('Pinned tool archive checksum mismatch')
    if pin.get('directory'):
        extracted=Path(temporary)/'tree';extracted.mkdir();total=0;files={}
        with tarfile.open(archive,'r:gz') as container:
            for entry in container:
                relative=Path(entry.name).relative_to(pin['directory'])
                if relative.is_absolute() or '..' in relative.parts:raise SystemExit('Unsafe tool path')
                destination=extracted/relative
                if entry.isdir():destination.mkdir(parents=True,exist_ok=True);continue
                if not entry.isfile():raise SystemExit('Unsupported tool archive member')
                total+=entry.size
                if total>3*1024**3 or len(files)>=50000:raise SystemExit('Tool extraction exceeds budget')
                destination.parent.mkdir(parents=True,exist_ok=True)
                with container.extractfile(entry) as source,destination.open('xb') as output:shutil.copyfileobj(source,output,1024*1024)
                destination.chmod(0o755 if entry.mode&0o111 else 0o644)
                files[str(relative)]=sha(destination)
        if not (extracted/pin['executable']).is_file():raise SystemExit('Tool executable missing')
        if target.exists():shutil.rmtree(target)
        os.replace(extracted,target)
        metadata.write_text(json.dumps({'archiveSha256':pin['sha256'],'files':files})+'\n')
        print(target);raise SystemExit(0)
    extracted=Path(temporary)/'executable'
    if pin['archive']=='zip':
        container=zipfile.ZipFile(archive)
        entry=container.getinfo(pin['executable'])
        if entry.is_dir() or entry.file_size>1024**3:raise SystemExit('Invalid tool executable size/type')
        source=container.open(entry)
    elif pin['archive']=='tar.gz':
        container=tarfile.open(archive,'r:gz')
        entry=container.getmember(pin['executable'])
        if not entry.isfile() or entry.size>1024**3:raise SystemExit('Invalid tool executable size/type')
        source=container.extractfile(entry)
    else:raise SystemExit('Unsupported archive format')
    with container,source,extracted.open('wb') as output:shutil.copyfileobj(source,output,1024*1024)
    extracted.chmod(0o755);digest=sha(extracted);os.replace(extracted,target)
    metadata.write_text(json.dumps({'archiveSha256':pin['sha256'],'executableSha256':digest})+'\n')
print(target)
