// Runs only at the host-controlled package installation boundary, outside TeX execution.
export function scribyraInstallTex(Module, name, contents) {
  if (typeof name !== 'string' || name.length > 240 || !/^(tex|fonts|bibtex|makeindex)\//.test(name) || name.split('/').some(p => !p || p === '.' || p === '..') || /[\\:\x00-\x1f\x7f]/.test(name)) throw new Error('Unsafe downloaded TeX path');
  const path = '/texmf-downloads/' + name, parts = path.split('/');
  let directory = '';
  for (const part of parts.slice(1, -1)) { directory += '/' + part; if (!Module.FS.analyzePath(directory).exists) Module.FS.mkdir(directory); }
  if (!Module.FS.analyzePath(path).exists) {
    const total = (Module.scribyraPackageBytes || 0) + contents.byteLength;
    if (total > 192 * 1024 * 1024) throw new Error('Downloaded TeX files exceed the 192 MiB worker limit');
    Module.FS.writeFile(path, contents); Module.scribyraPackageBytes = total;
  }
}
