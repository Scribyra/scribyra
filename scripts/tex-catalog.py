#!/usr/bin/env python3
"""Reproduce the compiler-matched catalog; downloads remain on upstream mirrors."""
import argparse, gzip, hashlib, io, json, lzma, os, pathlib, subprocess, tarfile, tempfile
URL = 'https://texlive.info/tlnet-archive/2026/03/02/tlnet/tlpkg/texlive.tlpdb.xz'
SHA256 = 'a331d7bb581657935a3a8f65c87452b341cc4ccd0966203d4eb81f5260456772'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--database', type=pathlib.Path, help='Use a local copy of the exact pinned upstream database; never substitute a different snapshot.')
parser.add_argument('--archives', type=pathlib.Path, help='Read repack verification inputs as <sha512>.tar.xz from this directory, without network fallback.')
parser.add_argument('--output', type=pathlib.Path, default=pathlib.Path('web/tex-catalog.json.gz'))
parser.add_argument('--check', action='store_true', help='Verify regenerated JSON against the retained catalog without writing.')
args = parser.parse_args()
if args.database:
    if args.database.stat().st_size > 8 * 1024 * 1024:
        raise SystemExit('Pinned database exceeds its size bound')
    data = args.database.read_bytes()
else:
    with tempfile.TemporaryDirectory() as work:
        target = pathlib.Path(work) / 'db.xz'
        subprocess.run(['curl', '--fail', '--location', '--silent', '--show-error', '--max-time', '120', URL, '-o', str(target)], check=True)
        if target.stat().st_size > 8 * 1024 * 1024:
            raise SystemExit('Pinned database exceeds its size bound')
        data = target.read_bytes()
if hashlib.sha256(data).hexdigest() != SHA256:
    raise SystemExit('TeX Live database differs from its pin; no catalog was changed. The historical endpoint may return an HTML challenge. Use --database with matching bytes, or npm run tex:catalog:check to verify retained inputs offline.')
packages = {}
for block in lzma.decompress(data, memlimit=128 * 1024 * 1024).decode().split('\n\n'):
    fields, files, runtime = {}, [], False
    for line in block.splitlines():
        if line.startswith(' '):
            if runtime:
                path = line.strip()
                path = path.removeprefix('RELOC/').removeprefix('texmf-dist/')
                if path.startswith(('tex/', 'fonts/', 'bibtex/', 'makeindex/')):
                    files.append(path)
            continue
        key, _, value = line.partition(' ')
        runtime = key == 'runfiles'
        fields[key] = value
    if files and fields.get('containerchecksum') and fields.get('category') == 'Package':
        packages[fields['name']] = dict(revision=int(fields['revision']), size=int(fields['containersize']), sha512=fields['containerchecksum'], files=files)
# TeX Live sometimes changes only archive/tlpobj metadata. Accept an explicitly
# pinned replacement only after comparing EVERY runtime file with the baseline.
# This is reproducible build-time verification; browsers need no archive proxy.
repacks = json.loads(pathlib.Path('scripts/tex-package-repacks.json').read_text())
def archive(url, checksum):
    if args.archives:
        data = (args.archives / (checksum + '.tar.xz')).read_bytes()
    else:
        data = subprocess.run(['curl', '--fail', '--location', '--silent', '--show-error', '--max-time', '120', url], check=True, stdout=subprocess.PIPE).stdout
    if hashlib.sha512(data).hexdigest() != checksum:
        raise SystemExit(f'Archive checksum changed: {url}')
    return data

def runtime_files(data):
    result = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:xz') as tar:
        for member in tar:
            name = member.name.removeprefix('RELOC/').removeprefix('texmf-dist/')
            if not member.isdir() and name.startswith(('tex/', 'fonts/', 'bibtex/', 'makeindex/')):
                if not member.isfile() or name in result:
                    raise SystemExit('Unexpected runtime archive entry')
                result[name] = tar.extractfile(member).read()
    return result

for name, repack in repacks.items():
    baseline = packages[name]
    old = archive(URL.rsplit('/tlpkg/', 1)[0] + '/archive/' + name + '.tar.xz', baseline['sha512'])
    new = archive(repack['source'], repack['sha512'])
    original, replacement = runtime_files(old), runtime_files(new)
    if set(original) != set(baseline['files']) or replacement != original or len(new) != repack['size']:
        raise SystemExit(f'{name}: replacement changes runtime files; refusing repack')
    packages[name] = {**baseline, **repack, 'runtimeRevision': baseline['revision']}
    print(f'{name}: all {len(original)} runtime files match baseline r{baseline["revision"]}')
catalog = dict(snapshot='texlive-2026-03-02', source=URL, sourceSha256=SHA256, packages=packages)
path = args.output
raw = (json.dumps(catalog, ensure_ascii=False, separators=(',', ':'), sort_keys=True) + '\n').encode()
unchanged = path.exists() and gzip.decompress(path.read_bytes()) == raw
if args.check:
    if not unchanged:
        raise SystemExit('Regenerated catalog differs from the retained JSON; no catalog was changed')
    print(f'All {len(packages)} runtime pins and repacks reproduce the retained catalog; no file changed')
else:
    if not unchanged:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.tex-catalog-', delete=False) as output:
                temporary = pathlib.Path(output.name)
                output.write(gzip.compress(raw, mtime=0))
                output.flush()
                os.fsync(output.fileno())
            os.chmod(temporary, 0o644)
            temporary.replace(path)
        finally:
            if temporary:
                temporary.unlink(missing_ok=True)
    print(f'{len(packages)} packages; {path.stat().st_size} bytes of metadata; ' + ('retained gzip bytes unchanged' if unchanged else 'review and update scripts/tex-runtime-catalog.json before building'))
