# Runs inside the sandbox as `bash -c <this> driver ARGS…` (bash and coreutils come from the
# TeX Live closure). It reports on fd $S ("pass N", "bibtex", "limit WHICH", "tex-error",
# "done"), writes the PDF to fd $P and the log to fd $L, and closes all three for TeX itself.
# The service trusts none of it beyond classifying the outcome; sizes are bounded outside.
S=$1 P=$2 L=$3 eng=$4 main=$5 passes=$6 bib=$7
# RLIMIT_NPROC counts every process of the user in the parent namespace, so it can only be
# set here, inside the job's own user namespace; the others are lowered from the outer values.
ulimit -u "$8" -n "$9" -f "${10}" -c 0 || { echo "limit-setup" >&"$S"; exit 99; }
job=${main##*/}; job=${job%.tex}
say() { echo "$*" >&"$S"; }
full() { local a; a=$(stat -f -c %a /work 2>/dev/null) && (( a < 2 )); }
# Job code could have replaced an output with a symlink: read only regular files, through
# O_NOFOLLOW (dd iflag=nofollow), so a swap after the check fails instead of being followed.
reg() { [[ -f $1 && ! -L $1 ]]; }
rd() { dd if="$1" iflag=nofollow bs=64K status=none 2>/dev/null; }
logtail() { reg "$job.log" && rd "$job.log" | tail -c 65536; }
send() {
  { reg "$job.log" && rd "$job.log"
    for x in blg; do reg "$job.$x" && { printf '\n--- %s.%s ---\n' "$job" "$x"; rd "$job.$x"; }; done; } >&"$L" 2>/dev/null
}
# 0: carry on; 1: stop (the reason has been said).
check() {
  local rc=$1 t
  full && { say "limit scratch"; return 1; }
  case $rc in
    0) return 0 ;;
    152|137) say "limit cpu" ;;
    153) say "limit output" ;;
    134) say "limit memory" ;;
    *) t=$(logtail)
       if [[ $t == *'not enough memory'* || $t == *'memory exhausted'* || $t == *'Cannot allocate memory'* ]]; then say "limit memory"; else say "tex-error"; fi ;;
  esac
  return 1
}
# bwrap's PID namespace hides the job's CPU time from the service's wait4, so the driver
# reports its children's time (bash `times`, second line) after every command.
run() { "$@" </dev/null >/dev/null 2>&1 {S}>&- {P}>&- {L}>&-; local rc=$?; say "times"; times >&"$S"; return $rc; }
flags=(-no-shell-escape -interaction=nonstopmode -halt-on-error)
[[ $eng == xelatex ]] && flags+=(-no-pdf)
rm -f -- "$job.pdf" "$job.xdv" "$job.log"
i=0 bibdone=0
while (( i < passes )); do
  i=$((i + 1)); before=; reg "$job.aux" && before=$(rd "$job.aux")
  say "pass $i"; run "$eng" "${flags[@]}" "$main"; check $? || { send; exit 0; }
  t=$(logtail); after=; reg "$job.aux" && after=$(rd "$job.aux"); again=0
  if (( !bibdone )) && [[ $bib == bibtex && $after == *'\bibdata{'* ]]; then
    bibdone=1 again=1; say "bibtex"; run bibtex "$job"; rc=$?; (( rc > 2 )) && { check $rc; send; exit 0; }
  elif (( !bibdone )) && [[ $bib == biber ]] && reg "$job.bcf"; then
    bibdone=1 again=1; say "biber"; run biber "$job"; rc=$?; (( rc > 2 )) && { check $rc; send; exit 0; }
  fi
  [[ $t == *'Rerun to get'* || $t == *'Rerun LaTeX'* || $t == *'Please rerun LaTeX'* || $t == *'Label(s) may have changed'* ]] && again=1
  [[ ($t == *'undefined references'* || $t == *'Citation(s) may have changed'*) && $before != "$after" ]] && again=1
  (( again )) || break
done
if [[ $eng == xelatex ]]; then run xdvipdfmx -q -o "$job.pdf" "$job.xdv"; check $? || { send; exit 0; }; fi
full && { say "limit scratch"; send; exit 0; }
reg "$job.pdf" && [[ -s $job.pdf ]] || { say "tex-error"; send; exit 0; }
rd "$job.pdf" >&"$P"; send; say "done"
