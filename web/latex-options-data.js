// Curated option data for LaTeX autocomplete, written for Scribyra (AGPL-3.0-only like the rest of
// the app). Option names are the public interface of each package or class as documented by its
// authors; the selection, grouping and descriptions are our own words. No list was copied from
// another editor. Loaded lazily with the command data.
//
// Entry: [name, description, values]. A name ending in `=` takes a value; `values` lists the
// finite choices (strings, or [value, description] pairs), or is omitted when the value is free.

const SIZES = ['10pt', '11pt', '12pt'];
const PAPER = [['a4paper', 'A4 paper (210 × 297 mm)'], ['letterpaper', 'US Letter paper (8.5 × 11 in)'], ['a5paper', 'A5 paper'], ['b5paper', 'B5 paper'], ['legalpaper', 'US Legal paper'], ['executivepaper', 'US Executive paper']];
const BOOL = ['true', 'false'];
const COLORS = ['black', 'blue', 'red', 'teal', 'magenta', 'cyan', 'violet', 'purple', 'brown', 'olive', 'orange', 'gray', 'darkgray', 'lightgray', 'white', 'green', 'yellow', 'pink', 'lime'];
const FONT_SIZES = ['tiny', 'scriptsize', 'footnotesize', 'small', 'normalsize', 'large', 'Large', 'LARGE', 'huge', 'Huge'];
const LANGUAGES = ['english', 'british', 'american', 'ngerman', 'german', 'austrian', 'french', 'spanish', 'italian', 'portuguese', 'brazilian', 'dutch', 'swedish', 'danish', 'norsk', 'finnish', 'polish', 'czech', 'slovak', 'russian', 'ukrainian', 'greek', 'turkish', 'romanian', 'hungarian', 'catalan', 'croatian', 'slovene', 'latin'];
const sizes = list => list.map(size => [size, `Base font size ${size}`]);

// Document classes.
const STANDARD = [
  ...sizes(SIZES), ...PAPER,
  ['landscape', 'Swap paper width and height'],
  ['onecolumn', 'Text in one column'], ['twocolumn', 'Text in two columns'],
  ['oneside', 'Same margins on every page'], ['twoside', 'Mirrored margins for printing on both sides'],
  ['titlepage', 'Title and abstract on pages of their own'], ['notitlepage', 'Title on the first page of text'],
  ['draft', 'Mark overfull lines; packages may skip images'], ['final', 'Final output (the default)'],
  ['fleqn', 'Displayed equations aligned left'], ['leqno', 'Equation numbers on the left'], ['openbib', 'Open bibliography format'],
];
const CHAPTERS = [['openright', 'Chapters start on right-hand pages'], ['openany', 'Chapters start on the next page']];
const KOMA = [
  ['fontsize=', 'Base font size', ['10pt', '11pt', '12pt']],
  ['paper=', 'Paper size or orientation', ['a4', 'a5', 'b5', 'letter', 'legal', 'executive', 'landscape', 'portrait']],
  ['DIV=', 'Type area division factor (larger means bigger text area)', ['calc', 'classic', 'default', '10', '12', '14']],
  ['BCOR=', 'Binding correction, as a length'],
  ['parskip=', 'Paragraphs separated by space instead of indentation', ['full', 'full-', 'full+', 'half', 'half-', 'half+', 'false']],
  ['headings=', 'Size of headings', ['big', 'normal', 'small']],
  ['twoside=', 'Mirrored margins', ['true', 'false', 'semi']],
  ['twocolumn=', 'Text in two columns', BOOL],
  ['titlepage=', 'Title on a page of its own', ['true', 'false', 'firstiscover']],
  ['toc=', 'Table of contents entries', ['bibliography', 'listof', 'index', 'flat', 'graduated', 'chapterentrywithdots']],
  ['numbers=', 'Period after section numbers', ['autoendperiod', 'endperiod', 'noendperiod']],
  ['captions=', 'Caption layout', ['tableheading', 'tablesignature', 'figureheading', 'figuresignature', 'centeredbeside', 'nooneline']],
  ['abstract=', 'Heading above the abstract', BOOL],
  ['draft=', 'Mark overfull lines', BOOL],
  ...PAPER.slice(0, 2), ...sizes(SIZES),
];
export const CLASS_OPTIONS = {
  article: STANDARD,
  report: [...STANDARD, ...CHAPTERS],
  book: [...STANDARD, ...CHAPTERS],
  amsart: [...STANDARD.filter(([name]) => name !== 'openbib'), ['reqno', 'Equation numbers on the right'], ['noamsfonts', 'Do not load the AMS fonts'], ['nomath', 'Do not load amsmath']],
  amsbook: [...STANDARD.filter(([name]) => name !== 'openbib'), ...CHAPTERS, ['reqno', 'Equation numbers on the right']],
  memoir: [
    ...sizes(['9pt', '10pt', '11pt', '12pt', '14pt', '17pt']), ['extrafontsizes', 'Allow base sizes above 17pt'],
    ...PAPER, ['ebook', 'Small 6 × 9 in pages'], ['landscape', 'Swap paper width and height'],
    ['oneside', 'Same margins on every page'], ['twoside', 'Mirrored margins'], ['onecolumn', 'One column'], ['twocolumn', 'Two columns'],
    ['openright', 'Chapters start on right-hand pages'], ['openleft', 'Chapters start on left-hand pages'], ['openany', 'Chapters start on the next page'],
    ['article', 'Typeset like an article: chapters without new pages'], ['oldfontcommands', 'Allow \\bf, \\it and similar old commands without warnings'],
    ['draft', 'Mark overfull lines'], ['final', 'Final output'], ['ms', 'Manuscript look: typewriter font, double spacing'], ['showtrims', 'Show trim marks'],
    ['fleqn', 'Displayed equations aligned left'], ['leqno', 'Equation numbers on the left'], ['openbib', 'Open bibliography format'],
  ],
  beamer: [
    ['aspectratio=', 'Slide shape', [['169', '16:9'], ['1610', '16:10'], ['43', '4:3 (default)'], ['149', '14:9'], ['141', '1.41:1 (A4 landscape)'], ['54', '5:4'], ['32', '3:2']]],
    ['handout', 'One slide per frame, overlays collapsed, for printing'], ['draft', 'Draft: headlines and sidebars as grey boxes'],
    ['t', 'Frame content aligned to the top'], ['c', 'Frame content centred vertically'],
    ...sizes(['8pt', '9pt', '10pt', '11pt', '12pt', '14pt', '17pt', '20pt']),
    ['compress', 'Compact navigation bars'], ['professionalfonts', 'Leave math fonts to the font packages'], ['ignorenonframetext', 'Ignore text outside frames'],
    ['notheorems', 'Do not define theorem environments'], ['noamsthm', 'Do not load amsthm'],
    ['xcolor=', 'Options passed on to xcolor', ['dvipsnames', 'svgnames', 'table']], ['hyperref=', 'Options passed on to hyperref'],
  ],
  scrartcl: KOMA, scrreprt: [...KOMA, ['open=', 'Where chapters start', ['right', 'left', 'any']], ['chapterprefix=', 'Write "Chapter" before chapter numbers', BOOL]],
  scrbook: [...KOMA, ['open=', 'Where chapters start', ['right', 'left', 'any']], ['chapterprefix=', 'Write "Chapter" before chapter numbers', BOOL]],
  standalone: [
    ['border=', 'Space around the content, as one to four lengths'], ['varwidth', 'Allow paragraphs and displays inside'], ['tikz', 'Each tikzpicture becomes its own page'],
    ['preview', 'Crop with the preview package'], ['crop', 'Crop the page to the content'], ['class=', 'Underlying class', ['article', 'report', 'book', 'scrartcl', 'memoir', 'beamer']],
    ['convert', 'Convert the PDF to an image (needs shell escape)'], ['multi', 'Several pages from marked environments'], ...sizes(SIZES),
  ],
  IEEEtran: [
    ['conference', 'Conference paper layout'], ['journal', 'Journal paper layout (the default)'], ['technote', 'Technical note layout'], ['peerreview', 'Single column with a cover page for review'],
    ['compsoc', 'IEEE Computer Society style'], ['comsoc', 'IEEE Communications Society style'], ['draftcls', 'Draft layout with double spacing'], ['draftclsnofoot', 'Draft layout without the footer'],
    ['onecolumn', 'One column'], ['twocolumn', 'Two columns (the default)'], ['oneside', 'One-sided'], ['twoside', 'Two-sided'],
    ...sizes(['9pt', '10pt', '11pt', '12pt']), ['a4paper', 'A4 paper'], ['letterpaper', 'US Letter paper'],
  ],
  llncs: [['runningheads', 'Print running heads'], ['orivec', 'Vectors with arrows instead of bold'], ['envcountsame', 'Theorem-like environments share one counter'], ['envcountsect', 'Number theorem-like environments within sections'], ['oribibl', 'Original LaTeX bibliography style'], ['citeauthoryear', 'Author-year citations']],
  elsarticle: [
    ['preprint', 'Preprint layout (the default)'], ['review', 'Double-spaced layout for review'], ['1p', 'Journal layout, one column, narrow'], ['3p', 'Journal layout, one or two columns'], ['5p', 'Journal layout, two columns'],
    ['twocolumn', 'Two columns'], ['authoryear', 'Author-year citations (natbib)'], ['number', 'Numbered citations (natbib)'], ['sort&compress', 'Sort and compress numbered citations'], ['times', 'Times fonts'], ...sizes(SIZES),
  ],
  'revtex4-2': [
    ['aps', 'American Physical Society journals'], ['aip', 'American Institute of Physics journals'], ['prl', 'Physical Review Letters'], ['pra', 'Physical Review A'], ['prb', 'Physical Review B'], ['prd', 'Physical Review D'], ['pre', 'Physical Review E'],
    ['reprint', 'Two-column layout close to the printed journal'], ['preprint', 'One-column, double-spaced preprint'], ['twocolumn', 'Two columns'], ['onecolumn', 'One column'],
    ['superscriptaddress', 'Affiliations marked with superscripts'], ['nofootinbib', 'Footnotes stay at the foot of the page'], ['amsmath', 'Load amsmath'], ['amssymb', 'Load amssymb'], ['showpacs', 'Show PACS codes'], ['showkeys', 'Show label keys'],
  ],
};

// Packages: options given in `\usepackage[…]`.
const CAPTION_KEYS = [
  ['font=', 'Font of the whole caption', [...FONT_SIZES, 'bf', 'it', 'sf', 'sl', 'up', 'rm', 'tt', 'md', 'sc']],
  ['labelfont=', 'Font of the label ("Figure 1")', [...FONT_SIZES, 'bf', 'it', 'sf', 'sl', 'up', 'rm', 'tt', 'md', 'sc']],
  ['textfont=', 'Font of the caption text', [...FONT_SIZES, 'bf', 'it', 'sf', 'sl', 'up', 'rm', 'tt', 'md', 'sc']],
  ['format=', 'Caption shape', [['plain', 'Text runs under the label'], ['hang', 'Text indented past the label']]],
  ['labelformat=', 'How the label is written', ['default', 'empty', 'simple', 'brace', 'parens']],
  ['labelsep=', 'Between label and text', ['colon', 'period', 'space', 'quad', 'newline', 'endash', 'none']],
  ['justification=', 'Alignment of the caption', ['justified', 'centering', 'centerlast', 'centerfirst', 'raggedright', 'RaggedRight', 'raggedleft']],
  ['singlelinecheck=', 'Centre captions that fit on one line', BOOL],
  ['position=', 'Whether the caption is above or below its content', ['top', 'above', 'bottom', 'below', 'auto']],
  ['skip=', 'Space between caption and content, as a length'], ['margin=', 'Margin on both sides of the caption, as a length'], ['width=', 'Fixed caption width, as a length'],
  ['indention=', 'Indentation from the second line, as a length'], ['hypcap=', 'Links jump to the float, not the caption', BOOL], ['list=', 'Caption appears in the list of figures or tables', BOOL],
  ['name=', 'Word in the label, such as "Fig."'], ['figurename=', 'Word for figure captions'], ['tablename=', 'Word for table captions'],
];
const HYPERREF_KEYS = [
  ['colorlinks', 'Colour link text instead of drawing boxes'], ['hidelinks', 'Links without colour or boxes'],
  ['colorlinks=', 'Colour link text instead of drawing boxes', BOOL],
  ['linkcolor=', 'Colour of internal links', COLORS], ['citecolor=', 'Colour of citation links', COLORS], ['urlcolor=', 'Colour of URL links', COLORS], ['filecolor=', 'Colour of file links', COLORS], ['allcolors=', 'One colour for every kind of link', COLORS],
  ['pdftitle=', 'Title in the PDF properties'], ['pdfauthor=', 'Author in the PDF properties'], ['pdfsubject=', 'Subject in the PDF properties'], ['pdfkeywords=', 'Keywords in the PDF properties'],
  ['bookmarks=', 'PDF bookmarks from the headings', BOOL], ['bookmarksopen=', 'Bookmarks expanded when opened', BOOL], ['bookmarksnumbered=', 'Section numbers in bookmarks', BOOL],
  ['pdfstartview=', 'Zoom when the PDF opens', ['Fit', 'FitH', 'FitV', 'FitB']], ['pdfpagemode=', 'Panel shown when the PDF opens', ['UseNone', 'UseOutlines', 'UseThumbs', 'FullScreen']],
  ['breaklinks=', 'Allow links to break across lines', BOOL], ['unicode=', 'Unicode in bookmarks', BOOL], ['pdfpagelabels=', 'Page labels as printed', BOOL], ['hypertexnames=', 'Link targets named after counters', BOOL],
  ['backref=', 'Back-references in the bibliography', ['page', 'section', 'slide', 'false']], ['pagebackref', 'Page back-references in the bibliography'],
  ['pdfborder=', 'Link border width, as "0 0 1"'], ['draft', 'Turn off all hypertext features'], ['final', 'Hypertext features on'],
];
const GEOMETRY_KEYS = [
  ...PAPER, ['landscape', 'Landscape orientation'], ['portrait', 'Portrait orientation'],
  ['margin=', 'All four margins, as a length'], ['left=', 'Left (inner) margin'], ['right=', 'Right (outer) margin'], ['top=', 'Top margin'], ['bottom=', 'Bottom margin'],
  ['inner=', 'Inner margin on two-sided pages'], ['outer=', 'Outer margin on two-sided pages'], ['hmargin=', 'Left and right margins'], ['vmargin=', 'Top and bottom margins'],
  ['textwidth=', 'Width of the text block'], ['textheight=', 'Height of the text block'], ['total=', 'Width and height of the body, as {w,h}'],
  ['scale=', 'Body as a fraction of the paper'], ['hscale=', 'Body width as a fraction of the paper'], ['vscale=', 'Body height as a fraction of the paper'],
  ['paperwidth=', 'Paper width'], ['paperheight=', 'Paper height'], ['papersize=', 'Paper size, as {w,h}'],
  ['headheight=', 'Height of the header'], ['headsep=', 'Space between header and text'], ['footskip=', 'Distance from text to footer baseline'],
  ['marginparwidth=', 'Width of margin notes'], ['marginparsep=', 'Space between text and margin notes'], ['bindingoffset=', 'Extra inner margin for binding'],
  ['includehead', 'Count the header in the body'], ['includefoot', 'Count the footer in the body'], ['includeheadfoot', 'Count header and footer in the body'], ['nohead', 'No space for a header'], ['nofoot', 'No space for a footer'],
  ['twoside', 'Mirror margins on even pages'], ['centering', 'Centre the body on the page'], ['heightrounded', 'Round the text height to whole lines'], ['showframe', 'Draw the page layout frames'],
];
const SIUNITX_KEYS = [
  ['round-mode=', 'Rounding of numbers', ['none', 'figures', 'places', 'uncertainty']], ['round-precision=', 'Digits kept when rounding'],
  ['group-digits=', 'Which digits are grouped', ['all', 'none', 'decimal', 'integer']], ['group-separator=', 'Separator between digit groups'],
  ['output-decimal-marker=', 'Decimal marker in output, such as {,}'], ['per-mode=', 'How "per" is written', ['power', 'fraction', 'symbol', 'repeated-symbol', 'power-positive-first', 'single-symbol']],
  ['separate-uncertainty=', 'Write uncertainty as ± value', BOOL], ['uncertainty-mode=', 'How uncertainties are written', ['full', 'compact', 'compact-marker', 'separate']],
  ['exponent-mode=', 'Exponent form', ['input', 'fixed', 'engineering', 'scientific', 'threshold']], ['table-format=', 'Column format of an S column, such as 2.3'],
  ['locale=', 'Conventions of a country', ['UK', 'US', 'DE', 'FR', 'PL', 'ZA']], ['range-phrase=', 'Word between range ends'], ['list-final-separator=', 'Word before the last list item'],
  ['inter-unit-product=', 'Between units, such as \\ensuremath{{}\\cdot{}}'], ['detect-all', 'Follow the surrounding font (siunitx 2)'],
];
const LISTINGS_KEYS = [
  ['language=', 'Programming language', ['Python', 'C', 'C++', 'Java', 'Matlab', 'R', 'HTML', 'XML', 'SQL', 'bash', 'TeX', '[LaTeX]TeX', 'Fortran', 'Haskell', 'Lisp', 'Perl', 'PHP', 'Ruby']],
  ['basicstyle=', 'Font of all code, such as \\ttfamily\\small'], ['keywordstyle=', 'Style of keywords'], ['commentstyle=', 'Style of comments'], ['stringstyle=', 'Style of strings'],
  ['numbers=', 'Line numbers', ['none', 'left', 'right']], ['numberstyle=', 'Style of line numbers'], ['stepnumber=', 'Number every n-th line'], ['firstnumber=', 'First line number', ['auto', 'last', '1']],
  ['frame=', 'Frame around the code', ['none', 'leftline', 'topline', 'bottomline', 'lines', 'single', 'shadowbox']],
  ['breaklines=', 'Break long lines', BOOL], ['showstringspaces=', 'Mark spaces in strings', BOOL], ['tabsize=', 'Spaces per tab'],
  ['captionpos=', 'Caption position', [['t', 'Top'], ['b', 'Bottom']]], ['caption=', 'Caption of the listing'], ['label=', 'Label of the listing'],
  ['backgroundcolor=', 'Background, such as \\color{lightgray}'], ['xleftmargin=', 'Extra left margin'], ['escapeinside=', 'Delimiters that switch back to LaTeX, such as {(*}{*)}'],
];
const MINTED_KEYS = [
  ['linenos', 'Number the lines'], ['breaklines', 'Break long lines'], ['autogobble', 'Remove common leading whitespace'], ['mathescape', 'Allow math in comments'],
  ['frame=', 'Frame around the code', ['none', 'leftline', 'topline', 'bottomline', 'lines', 'single']],
  ['fontsize=', 'Font size', FONT_SIZES.map(size => '\\' + size)], ['style=', 'Pygments colour style', ['default', 'friendly', 'colorful', 'manni', 'monokai', 'murphy', 'native', 'pastie', 'perldoc', 'tango', 'vs', 'xcode', 'bw']],
  ['bgcolor=', 'Background colour', COLORS], ['tabsize=', 'Spaces per tab'], ['xleftmargin=', 'Extra left margin'], ['numbersep=', 'Space between numbers and code'], ['firstnumber=', 'First line number'], ['escapeinside=', 'Two characters that switch back to LaTeX'],
];
const ENUMITEM_KEYS = [
  ['label=', 'Label of each item, such as (\\alph*)'], ['label*=', 'Label appended to the parent list label'], ['ref=', 'How references to items are written'], ['start=', 'Number of the first item'], ['resume', 'Continue numbering of the previous list'],
  ['leftmargin=', 'Left margin of the list', ['*', '0pt', '!']], ['labelindent=', 'Indentation of the label'], ['labelwidth=', 'Width of the label box'], ['labelsep=', 'Space between label and text'], ['align=', 'Label alignment', ['left', 'right', 'parleft']],
  ['itemsep=', 'Extra space between items'], ['topsep=', 'Space above and below the list'], ['parsep=', 'Space between paragraphs in an item'], ['noitemsep', 'No extra space between items'], ['nosep', 'No vertical space at all'], ['wide', 'Labels flush with the text margin'],
  ['font=', 'Font of the label, such as \\bfseries'], ['before=', 'Code run before the list'], ['after=', 'Code run after the list'],
];
const TIKZ_KEYS = [
  ['draw', 'Stroke the path'], ['fill', 'Fill the path'], ['draw=', 'Stroke colour', COLORS], ['fill=', 'Fill colour', COLORS], ['color=', 'Colour of lines, fills and text', COLORS], ['text=', 'Text colour', COLORS],
  ['thin', 'Thin lines (0.4pt)'], ['thick', 'Thick lines (0.8pt)'], ['very thick', 'Very thick lines (1.2pt)'], ['ultra thick', 'Ultra thick lines (1.6pt)'], ['very thin', 'Very thin lines'], ['ultra thin', 'Ultra thin lines'], ['line width=', 'Line width, as a length'],
  ['dashed', 'Dashed line'], ['dotted', 'Dotted line'], ['densely dashed', 'Densely dashed line'], ['loosely dotted', 'Loosely dotted line'], ['solid', 'Solid line'],
  ['->', 'Arrow tip at the end'], ['<-', 'Arrow tip at the start'], ['<->', 'Arrow tips at both ends'], ['>=', 'Default arrow tip', ['stealth', 'latex', 'to', 'Stealth', 'Latex', 'Triangle']],
  ['rounded corners', 'Round path corners'], ['rounded corners=', 'Round path corners with a radius'], ['sharp corners', 'Sharp path corners'],
  ['scale=', 'Scale factor'], ['xscale=', 'Horizontal scale'], ['yscale=', 'Vertical scale'], ['rotate=', 'Rotation in degrees'], ['xshift=', 'Horizontal shift'], ['yshift=', 'Vertical shift'], ['shift=', 'Shift, as {(x,y)}'],
  ['opacity=', 'Opacity of everything, 0 to 1'], ['fill opacity=', 'Opacity of fills and text'], ['draw opacity=', 'Opacity of strokes'],
  ['above', 'Node above the point'], ['below', 'Node below the point'], ['left', 'Node left of the point'], ['right', 'Node right of the point'], ['above left', 'Node above left'], ['above right', 'Node above right'], ['below left', 'Node below left'], ['below right', 'Node below right'],
  ['anchor=', 'Node anchor placed at the point', ['center', 'north', 'south', 'east', 'west', 'north east', 'north west', 'south east', 'south west', 'base', 'mid']],
  ['circle', 'Circular node shape'], ['rectangle', 'Rectangular node shape'], ['inner sep=', 'Space between node text and border'], ['outer sep=', 'Space outside the node border'],
  ['minimum width=', 'Minimum node width'], ['minimum height=', 'Minimum node height'], ['minimum size=', 'Minimum node width and height'],
  ['align=', 'Alignment of multi-line node text', ['left', 'center', 'right', 'justify']], ['text width=', 'Width of node text'], ['font=', 'Font of node text, such as \\small'],
  ['node distance=', 'Distance for relative node placement'], ['every node/.style=', 'Style applied to every node'], ['baseline', 'Align the picture with the text baseline'], ['baseline=', 'Picture baseline'],
];
const GRAPHICX_KEYS = [
  ['width=', 'Image width, such as \\linewidth', ['\\linewidth', '\\textwidth', '0.5\\linewidth', '\\columnwidth']], ['height=', 'Image height'], ['totalheight=', 'Height including depth'],
  ['scale=', 'Scale factor'], ['angle=', 'Rotation in degrees'], ['origin=', 'Rotation origin', ['c', 'l', 'r', 't', 'b', 'lt', 'rb']], ['keepaspectratio', 'Fit width and height without distortion'],
  ['trim=', 'Trim left bottom right top, as lengths'], ['clip', 'Clip to the trimmed area'], ['page=', 'Page of a PDF to include'], ['draft', 'Show a box instead of the image'],
];

export const PACKAGE_OPTIONS = {
  geometry: GEOMETRY_KEYS,
  babel: [...LANGUAGES.map(language => [language, 'Language']), ['main=', 'Main document language', LANGUAGES], ['shorthands=', 'Language shorthands such as "a in German', ['off']], ['provide=', 'Create missing language definitions from ini files', ['*', '+*']]],
  hyperref: HYPERREF_KEYS,
  inputenc: [['utf8', 'UTF-8 input (the default since 2018)'], ['latin1', 'ISO 8859-1 input'], ['latin9', 'ISO 8859-15 input'], ['ansinew', 'Windows code page 1252'], ['cp1252', 'Windows code page 1252'], ['applemac', 'Mac Roman input']],
  fontenc: [['T1', '8-bit Latin font encoding (hyphenates accented words)'], ['OT1', 'Original 7-bit TeX encoding'], ['T2A', 'Cyrillic'], ['LGR', 'Greek'], ['TS1', 'Text companion symbols'], ['LY1', 'Y&Y encoding'], ['T5', 'Vietnamese']],
  xcolor: [['dvipsnames', 'Load the 68 dvips colour names'], ['svgnames', 'Load the SVG colour names'], ['x11names', 'Load the X11 colour names'], ['table', 'Load colortbl for coloured table rows and cells'], ['hyperref', 'Support hyperref colour models'], ['cmyk', 'Convert colours to CMYK'], ['rgb', 'Convert colours to RGB'], ['gray', 'Convert colours to grey'], ['monochrome', 'Turn all colours black'], ['natural', 'Keep each colour in its model']],
  graphicx: [['draft', 'Show boxes instead of images'], ['final', 'Show images'], ['hiderotate', 'Do not rotate'], ['hidescale', 'Do not scale'], ['dvips', 'Driver for dvips'], ['pdftex', 'Driver for pdfTeX'], ['xetex', 'Driver for XeTeX'], ['luatex', 'Driver for LuaTeX']],
  biblatex: [
    ['backend=', 'Program that processes the bibliography', [['biber', 'Biber (full Unicode, all features)'], ['bibtex', 'BibTeX (limited features)'], ['bibtex8', '8-bit BibTeX']]],
    ['style=', 'Citation and bibliography style', ['numeric', 'numeric-comp', 'alphabetic', 'authoryear', 'authoryear-comp', 'authortitle', 'verbose', 'apa', 'ieee', 'nature', 'chem-acs', 'phys', 'mla', 'chicago-authordate']],
    ['citestyle=', 'Citation style only', ['numeric', 'numeric-comp', 'alphabetic', 'authoryear', 'authoryear-comp', 'authortitle', 'verbose']], ['bibstyle=', 'Bibliography style only', ['numeric', 'alphabetic', 'authoryear', 'authortitle', 'verbose']],
    ['sorting=', 'Order of the bibliography', [['nty', 'Name, title, year'], ['nyt', 'Name, year, title'], ['nyvt', 'Name, year, volume, title'], ['anyt', 'Label, name, year, title'], ['ynt', 'Year, name, title'], ['ydnt', 'Year descending, name, title'], ['none', 'Order of citation']]],
    ['maxnames=', 'Names shown before "et al."'], ['minnames=', 'Names shown when truncated'], ['maxbibnames=', 'Names in the bibliography'], ['maxcitenames=', 'Names in citations'],
    ['giveninits=', 'Initials for given names', BOOL], ['uniquename=', 'Disambiguate names in citations', ['true', 'false', 'init', 'full', 'allinit', 'allfull', 'mininit', 'minfull']], ['uniquelist=', 'Disambiguate name lists', ['true', 'false', 'minyear']],
    ['url=', 'Print URLs', BOOL], ['doi=', 'Print DOIs', BOOL], ['isbn=', 'Print ISBNs', BOOL], ['eprint=', 'Print e-print identifiers', BOOL], ['dashed=', 'Dash for repeated authors', BOOL],
    ['natbib=', 'Provide natbib-style citation commands', BOOL], ['hyperref=', 'Link citations', ['true', 'false', 'auto']], ['backref=', 'Back-references in the bibliography', BOOL],
    ['language=', 'Language of bibliography strings', ['auto', ...LANGUAGES.slice(0, 12)]], ['date=', 'Date format', ['year', 'short', 'long', 'terse', 'comp', 'iso']],
    ['refsection=', 'Separate bibliographies per', ['none', 'part', 'chapter', 'section', 'subsection']], ['autocite=', 'What \\autocite produces', ['plain', 'inline', 'footnote', 'superscript']],
  ],
  natbib: [['round', 'Round parentheses (the default)'], ['square', 'Square brackets'], ['curly', 'Curly braces'], ['angle', 'Angle brackets'], ['semicolon', 'Semicolons between citations'], ['comma', 'Commas between citations'], ['authoryear', 'Author-year citations'], ['numbers', 'Numbered citations'], ['super', 'Superscript numbers'], ['sort', 'Sort multiple citations'], ['sort&compress', 'Sort and compress number ranges'], ['compress', 'Compress number ranges'], ['longnamesfirst', 'Full author list on first citation'], ['sectionbib', 'Bibliography as a section'], ['nonamebreak', 'Keep author names on one line']],
  amsmath: [['leqno', 'Equation numbers on the left'], ['reqno', 'Equation numbers on the right (the default)'], ['fleqn', 'Displayed equations aligned left'], ['centertags', 'Centre split equation numbers vertically'], ['tbtags', 'Split equation numbers at the first or last line'], ['sumlimits', 'Limits of sums above and below'], ['nosumlimits', 'Limits of sums beside'], ['intlimits', 'Limits of integrals above and below'], ['nointlimits', 'Limits of integrals beside'], ['namelimits', 'Limits of named operators above and below'], ['nonamelimits', 'Limits of named operators beside']],
  mathtools: [['fixamsmath', 'Apply fixes to amsmath (the default)'], ['donotfixamsmathbugs', 'Leave amsmath unchanged'], ['leqno', 'Equation numbers on the left'], ['reqno', 'Equation numbers on the right'], ['fleqn', 'Displayed equations aligned left']],
  siunitx: SIUNITX_KEYS,
  cleveref: [['capitalise', 'Capitalise reference names'], ['capitalize', 'Capitalize reference names'], ['nameinlink', 'Include the name in the link'], ['noabbrev', 'Do not abbreviate names'], ['poorman', 'Write a sed script for submissions without cleveref'], ['sort', 'Sort multiple references'], ['compress', 'Compress ranges'], ['nosort', 'Keep the given order'], ['english', 'English names'], ['ngerman', 'German names'], ['french', 'French names'], ['spanish', 'Spanish names'], ['italian', 'Italian names'], ['dutch', 'Dutch names']],
  caption: CAPTION_KEYS,
  subcaption: CAPTION_KEYS,
  listings: [['draft', 'Skip listings'], ['final', 'Typeset listings'], ['savemem', 'Save memory by loading fewer definitions'], ['noaspects', 'Load no aspects']],
  minted: [['cache=', 'Cache highlighted code', BOOL], ['cachedir=', 'Folder for the cache'], ['finalizecache', 'Prepare the cache for use without shell escape'], ['frozencache', 'Use the cache only, without Pygments'], ['outputdir=', 'Folder of the build output'], ['newfloat', 'Define the listing float with newfloat'], ['section', 'Number listings within sections'], ['chapter', 'Number listings within chapters']],
  enumitem: [['inline', 'Inline lists: enumerate*, itemize*, description*'], ['shortlabels', 'Allow labels like (a) or i. as the optional argument'], ['ignoredisplayed', 'Ignore display spacing'], ['loadonly', 'Load without changing standard lists'], ['sizes', 'Font-size-dependent values']],
  microtype: [['protrusion=', 'Character protrusion (margin kerning)', ['true', 'false', 'compatibility', 'nocompatibility']], ['expansion=', 'Font expansion', BOOL], ['tracking=', 'Letterspacing of small caps', ['true', 'false', 'smallcaps']], ['kerning=', 'Additional kerning', BOOL], ['spacing=', 'Adjusted interword spacing', BOOL], ['final', 'Enable features in draft mode'], ['draft', 'Disable all features'], ['babel=', 'Language-specific adjustments', BOOL], ['letterspace=', 'Default letterspacing amount'], ['factor=', 'Protrusion factor'], ['stretch=', 'Maximum expansion stretch'], ['shrink=', 'Maximum expansion shrink'], ['step=', 'Expansion step']],
  csquotes: [['autostyle=', 'Quote style follows the document language', ['true', 'false', 'try', 'once', 'tryonce']], ['style=', 'Fixed quote style', ['english', 'german', 'french', 'italian', 'spanish', 'dutch', 'swedish', 'danish', 'norwegian', 'portuguese', 'swiss']], ['english=', 'English variant', ['american', 'british']], ['german=', 'German variant', ['quotes', 'guillemets', 'swiss']], ['strict=', 'Turn warnings into errors', BOOL], ['autopunct=', 'Move punctuation into quotations', BOOL], ['csdisplay=', 'Block quotations always displayed', BOOL], ['threshold=', 'Lines or words before a block quote is displayed'], ['thresholdtype=', 'Unit of the threshold', ['lines', 'words']], ['maxlevel=', 'Maximum nesting level']],
  todonotes: [['disable', 'Hide all notes'], ['draft', 'Show notes (the default)'], ['final', 'Hide notes'], ['colorinlistoftodos', 'Coloured markers in the list of notes'], ['obeyDraft', 'Show notes only in draft mode'], ['obeyFinal', 'Hide notes in final mode'], ['prependcaption', 'Use the note text as its caption'], ['textwidth=', 'Width of notes'], ['textsize=', 'Font size of notes', FONT_SIZES], ['color=', 'Background colour of notes', COLORS], ['backgroundcolor=', 'Background colour of notes', COLORS], ['bordercolor=', 'Border colour of notes', COLORS], ['linecolor=', 'Colour of the line to the note', COLORS], ['shadow', 'Notes cast a shadow'], ['figwidth=', 'Width of missing-figure boxes'], ['figheight=', 'Height of missing-figure boxes']],
  fontspec: [['no-math', 'Leave math fonts alone'], ['quiet', 'Fewer messages in the log']],
  url: [['hyphens', 'Allow breaks after hyphens'], ['spaces', 'Keep spaces in URLs'], ['obeyspaces', 'Keep spaces in URLs'], ['lowtilde', 'Low tilde'], ['allowmove', 'Allow \\url inside moving arguments']],
  setspace: [['singlespacing', 'Single spacing'], ['onehalfspacing', 'One-and-a-half spacing'], ['doublespacing', 'Double spacing'], ['nodisplayskipstretch', 'Do not stretch space around displays']],
  lineno: [['left', 'Numbers in the left margin'], ['right', 'Numbers in the right margin'], ['switch', 'Numbers in the outer margin'], ['pagewise', 'Restart numbers on each page'], ['running', 'Numbers run through the document'], ['modulo', 'Print every fifth number'], ['mathlines', 'Number lines of displayed math'], ['displaymath', 'Number around displayed math']],
  parskip: [['skip=', 'Space between paragraphs'], ['indent=', 'Paragraph indentation'], ['parfill=', 'Fill of the last line of a paragraph'], ['tocskip=', 'Space between table of contents entries']],
  titlesec: [['rm', 'Roman headings'], ['sf', 'Sans-serif headings'], ['tt', 'Typewriter headings'], ['md', 'Medium-weight headings'], ['bf', 'Bold headings'], ['up', 'Upright headings'], ['it', 'Italic headings'], ['sl', 'Slanted headings'], ['sc', 'Small-caps headings'], ['big', 'Large headings'], ['medium', 'Medium headings'], ['small', 'Small headings'], ['tiny', 'Text-size headings'], ['raggedright', 'Headings ragged right'], ['center', 'Centred headings'], ['raggedleft', 'Headings ragged left'], ['compact', 'Less space around headings'], ['uppercase', 'Upper-case headings'], ['explicit', 'Title text given as #1 in \\titleformat'], ['pagestyles', 'Load the page style tools']],
  glossaries: [['acronym', 'Separate list of acronyms'], ['toc', 'Glossaries in the table of contents'], ['nonumberlist', 'No page lists'], ['nopostdot', 'No dot after descriptions'], ['nogroupskip', 'No space between letter groups'], ['section=', 'Glossary heading level', ['part', 'chapter', 'section', 'subsection']], ['style=', 'Glossary layout', ['list', 'altlist', 'listgroup', 'long', 'long3col', 'longheader', 'super', 'tree', 'index', 'indexgroup']], ['automake', 'Run makeindex automatically (needs shell escape)'], ['xindy', 'Use xindy instead of makeindex'], ['numberedsection', 'Numbered glossary sections'], ['symbols', 'Separate list of symbols']],
  algorithm2e: [['ruled', 'Rules above and below, caption on top'], ['vlined', 'Vertical lines for blocks'], ['linesnumbered', 'Number the lines'], ['boxed', 'Algorithm in a box'], ['boxruled', 'Box with caption rule'], ['plain', 'Plain layout'], ['noline', 'No block lines'], ['lined', 'Block lines with end markers'], ['noend', 'No end keywords'], ['longend', 'Keyword-specific end markers'], ['algochapter', 'Number within chapters'], ['algosection', 'Number within sections'], ['english', 'English keywords'], ['french', 'French keywords'], ['german', 'German keywords'], ['commentsnumbered', 'Number comment lines'], ['inoutnumbered', 'Number input and output lines']],
  tcolorbox: [['most', 'Load most libraries'], ['all', 'Load every library'], ['skins', 'Skins library'], ['breakable', 'Boxes that break across pages'], ['theorems', 'Theorem boxes'], ['listings', 'Boxes with listings code'], ['minted', 'Boxes with minted code'], ['hooks', 'Hooks library'], ['raster', 'Grids of boxes'], ['fitting', 'Fit text into a box']],
  appendix: [['toc', 'Heading in the table of contents'], ['page', 'Heading page before the appendices'], ['title', 'Prefix each appendix with its name'], ['titletoc', 'Prefix table of contents entries'], ['header', 'Name in page headers']],
  tocbibind: [['nottoc', 'Leave the contents out of itself'], ['notlof', 'Leave the list of figures out'], ['notlot', 'Leave the list of tables out'], ['notbib', 'Leave the bibliography out'], ['notindex', 'Leave the index out'], ['numbib', 'Number the bibliography heading'], ['numindex', 'Number the index heading'], ['chapter', 'Entries at chapter level'], ['section', 'Entries at section level']],
};

// Keys of commands that take key=value settings (`\hypersetup{…}`, `\includegraphics[…]` and the like).
export const KEYS = {
  graphicx: GRAPHICX_KEYS, hyperref: HYPERREF_KEYS.filter(([name]) => name !== 'draft' && name !== 'final'), geometry: GEOMETRY_KEYS, siunitx: SIUNITX_KEYS,
  caption: CAPTION_KEYS, listings: LISTINGS_KEYS, minted: MINTED_KEYS, enumitem: ENUMITEM_KEYS, tikz: TIKZ_KEYS,
};
