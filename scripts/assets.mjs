import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, access, writeFile, rename } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
const version = '1.4.1';
const sha256 = '4f63731fe4ec9238d877846074ab424350add6f6e956944def389e6752d2c78b';
const archive = '.cache/busytex-assets.tar.gz';
await mkdir('.cache', { recursive: true }); await mkdir('public/core', { recursive: true });
try { await access(archive); } catch {
  console.log('Downloading pinned BusyTeX 1.4.1 assets (522 MB compressed)…');
  const response = await fetch(`https://github.com/TeXlyre/texlyre-busytex/releases/download/assets-v${version}/busytex-assets.tar.gz`);
  if (!response.ok) throw new Error(`Asset download failed: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(`${archive}.partial`));
  await rename(`${archive}.partial`, archive);
}
const hash = createHash('sha256');
for await (const chunk of createReadStream(archive)) hash.update(chunk);
if (hash.digest('hex') !== sha256) throw new Error('Compiler archive checksum mismatch; delete .cache/busytex-assets.tar.gz and retry.');
execFileSync('tar', ['-xzf', archive, '-C', 'public/core']);
await import('./patch-busytex.mjs');
await writeFile('public/core/manifest.json', JSON.stringify({ version, sha256 }, null, 2));
execFileSync('cargo',['run','--release','-p','scribyra-assets'],{stdio:'inherit'});
console.log('Verified compiler assets extracted into public/core.');
