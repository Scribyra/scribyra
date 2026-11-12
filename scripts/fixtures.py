"""Deterministic, redistributable fixtures: no external fonts, images, or templates."""
from pathlib import Path
import zipfile, json, struct, zlib
root = Path('fixtures'); root.mkdir(exist_ok=True)
public = Path('public/fixtures'); public.mkdir(parents=True, exist_ok=True)
def png():
    def chunk(kind, data): return struct.pack('!I', len(data))+kind+data+struct.pack('!I', zlib.crc32(kind+data)&0xffffffff)
    pixels = b''.join(b'\x00'+bytes([104,86,216])*64 for _ in range(32))
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR', struct.pack('!2I5B',64,32,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(pixels))+chunk(b'IEND',b'')
bib = '@book{knuth1984,author={Donald E. Knuth},title={The TeXbook},year={1984},publisher={Addison-Wesley}}'
fixtures = {
'article': {'main.tex': r'''\documentclass{article}
\usepackage{amsmath,graphicx}
\begin{document}
\title{Scribyra feasibility article}\author{Scribyra}\maketitle
\section{Mathematics}\label{sec:math}
The Gaussian integral is $\int_{-\infty}^{\infty}e^{-x^2}\,dx=\sqrt\pi$.
\section{Images and references}
See Section~\ref{sec:math}.\par\includegraphics[width=2cm]{figure.png}
\end{document}''', 'figure.png': png()},
'unicode': {'main.tex': r'''\documentclass{article}
\usepackage{fontspec}
\setmainfont{Latin Modern Roman}
\begin{document}
\section{Unicode and typography}
Café, naïve, façade, über, España.\par
\textbf{Bold text}, \textit{italic text}, and ligatures: office, affinity.
\end{document}'''.replace(r'\u00e9','é').replace(r'\u00ef','ï').replace(r'\u00e7','ç').replace(r'\u00fc','ü').replace(r'\u00f1','ñ')},
'bibtex': {'main.tex': r'''\documentclass{article}
\begin{document}The original reference~\cite{knuth1984}.
\bibliographystyle{plain}\bibliography{references}\end{document}''', 'references.bib':bib},
'biber': {'main.tex': r'''\documentclass{article}\usepackage[backend=biber]{biblatex}\addbibresource{references.bib}
\begin{document}The original reference~\cite{knuth1984}.\printbibliography\end{document}''','references.bib':bib},
'missing-package': {'main.tex':r'\documentclass{article}\usepackage{scribyra-does-not-exist}\begin{document}Test\end{document}'},
'romanian': {
    'main.tex': r'''\documentclass{thesis}
\addbibresource{references.bib}
\begin{document}
\section{Cercetare și învățare}
O referință bibliografică: \cite{knuth1984}.
\printbibliography
\end{document}''',
    'Thesis.cls': r'''\ProvidesClass{thesis}
\LoadClass{article}
\RequirePackage[romanian]{babel}
\RequirePackage[T1]{fontenc}
\RequirePackage[style=numeric]{biblatex}''',
    'references.bib': r'''@book{knuth1984,author={P{\'e}rez, Ana and M{\"u}ller, Max},title={Notes\textemdash a reproducible workflow},year={2026},publisher={Example Press}}''',
},
'runaway': {'main.tex':r'\documentclass{article}\begin{document}\newcount\x\loop\advance\x by1\iftrue\repeat\end{document}'},
}
chapters = {}
for n in range(1,101):
    chapters[f'chapters/page-{n:03}.tex'] = '\\section*{Chapter '+str(n)+'}\n'+('Research is a conversation between evidence and ideas. A reproducible workflow makes that conversation easier to follow.\n\n'*10)+('\\newpage\n' if n < 100 else '')
fixtures['thesis'] = {'main.tex': '\\documentclass[10pt]{article}\n\\usepackage[margin=1in]{geometry}\n\\begin{document}\n'+''.join(f'\\input{{chapters/page-{n:03}}}\n' for n in range(1,101))+'\\end{document}\n', **chapters}
for name, files in fixtures.items():
    folder = root / name; folder.mkdir(exist_ok=True)
    for path, content in files.items():
        out = folder/path; out.parent.mkdir(parents=True,exist_ok=True); out.write_bytes(content if isinstance(content,bytes) else content.encode())
    with zipfile.ZipFile(public/f'{name}.zip','w',zipfile.ZIP_DEFLATED) as archive:
        for path, content in files.items():
            info=zipfile.ZipInfo(path,(2026,1,1,0,0,0)); info.compress_type=zipfile.ZIP_DEFLATED
            archive.writestr(info,content if isinstance(content,bytes) else content.encode())
(root/'manifest.json').write_text(json.dumps({'article':['pdflatex'],'unicode':['xelatex','lualatex'],'bibtex':['pdflatex'],'biber':['pdflatex'],'romanian':['pdflatex'],'thesis':['pdflatex'],'missing-package':['pdflatex'],'runaway':['pdflatex']},indent=2)+'\n')
print('Generated fixtures and importable ZIPs in public/fixtures.')
