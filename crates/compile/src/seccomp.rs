//! The seccomp-BPF filter every sandboxed process runs under (design section 6). Built by hand
//! as an allow list: every system call not listed in [`allowed`] fails with `ENOSYS`. Checked
//! first, [`denied`] fails with `EPERM` (the calls the design names, kept explicit so a later
//! edit of the allow list cannot let them through); `clone` is refused when it asks for any
//! namespace, `clone3` gets `ENOSYS` (its flags sit behind a pointer the filter cannot read, so
//! libc falls back to `clone`), `socket` is allowed for `AF_UNIX` only, and every foreign ABI
//! (i386, x32) is refused outright. bwrap loads it (`--seccomp FD`, with `no_new_privs`) just
//! before the exec.
//!
//! The allow list is what bash, coreutils, pdfTeX, XeTeX (with fontconfig and xdvipdfmx),
//! LuaHBTeX, BibTeX and the tests' Python probe call (traced with `strace -f` over the test
//! suite, see `docs/service.md`), plus ordinary glibc relatives of those calls.

const LD_W_ABS: u16 = 0x20; // BPF_LD | BPF_W | BPF_ABS
const JEQ_K: u16 = 0x15; // BPF_JMP | BPF_JEQ | BPF_K
const JGE_K: u16 = 0x35; // BPF_JMP | BPF_JGE | BPF_K
const JSET_K: u16 = 0x45; // BPF_JMP | BPF_JSET | BPF_K
const RET_K: u16 = 0x06; // BPF_RET | BPF_K
const JA: u16 = 0x05; // BPF_JMP | BPF_JA
const RET_ALLOW: u32 = 0x7fff_0000;
const RET_ERRNO: u32 = 0x0005_0000;
// struct seccomp_data: nr at 0, arch at 4, args[i] at 16 + 8 i (low word first on little endian).
const OFF_NR: u32 = 0;
const OFF_ARCH: u32 = 4;
const OFF_ARG0: u32 = 16;

#[cfg(target_arch = "x86_64")]
const ARCH: u32 = 0xc000_003e; // AUDIT_ARCH_X86_64
#[cfg(target_arch = "aarch64")]
const ARCH: u32 = 0xc000_00b7; // AUDIT_ARCH_AARCH64
#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
compile_error!("scribyra-compile builds its seccomp filter for x86_64 and aarch64 only");

/// CLONE_NEWNS | NEWCGROUP | NEWUTS | NEWIPC | NEWUSER | NEWPID | NEWNET | NEWTIME.
pub const CLONE_NAMESPACES: u32 = 0x0002_0000 | 0x0200_0000 | 0x0400_0000 | 0x0800_0000 | 0x1000_0000 | 0x2000_0000 | 0x4000_0000 | 0x80;

/// The refused system calls, as (name, number) for this architecture.
pub fn denied() -> Vec<(&'static str, i64)> {
  use libc::*;
  let mut v: Vec<(&'static str, i64)> = vec![
    ("ptrace", SYS_ptrace), ("mount", SYS_mount), ("umount2", SYS_umount2), ("pivot_root", SYS_pivot_root), ("chroot", SYS_chroot),
    ("unshare", SYS_unshare), ("setns", SYS_setns), ("keyctl", SYS_keyctl), ("add_key", SYS_add_key), ("request_key", SYS_request_key),
    ("bpf", SYS_bpf), ("perf_event_open", SYS_perf_event_open), ("userfaultfd", SYS_userfaultfd),
    ("io_uring_setup", SYS_io_uring_setup), ("io_uring_enter", SYS_io_uring_enter), ("io_uring_register", SYS_io_uring_register),
    ("personality", SYS_personality), ("init_module", SYS_init_module), ("finit_module", SYS_finit_module), ("delete_module", SYS_delete_module),
    ("reboot", SYS_reboot), ("kexec_load", SYS_kexec_load), ("kexec_file_load", SYS_kexec_file_load),
    ("open_tree", SYS_open_tree), ("move_mount", SYS_move_mount), ("fsopen", SYS_fsopen), ("fsconfig", SYS_fsconfig), ("fsmount", SYS_fsmount),
    ("fspick", SYS_fspick), ("mount_setattr", SYS_mount_setattr), ("swapon", SYS_swapon), ("swapoff", SYS_swapoff), ("acct", SYS_acct),
    ("quotactl", SYS_quotactl), ("syslog", SYS_syslog), ("process_vm_readv", SYS_process_vm_readv), ("process_vm_writev", SYS_process_vm_writev),
    ("name_to_handle_at", SYS_name_to_handle_at), ("open_by_handle_at", SYS_open_by_handle_at), ("kcmp", SYS_kcmp),
    ("pidfd_getfd", SYS_pidfd_getfd), ("fanotify_init", SYS_fanotify_init), ("vhangup", SYS_vhangup),
    // No anonymous shared memory outside the scratch tmpfs (no engine needs it).
    ("memfd_create", SYS_memfd_create), ("memfd_secret", SYS_memfd_secret),
  ];
  #[cfg(target_arch = "x86_64")]
  v.extend([("iopl", SYS_iopl), ("ioperm", SYS_ioperm), ("uselib", SYS_uselib), ("lookup_dcookie", SYS_lookup_dcookie)]);
  v
}

/// The allowed system calls (besides `clone` and `socket`, which are checked by argument).
pub fn allowed() -> Vec<i64> {
  use libc::*;
  let mut v = vec![
    // memory, threads, signals, time
    SYS_brk, SYS_mmap, SYS_munmap, SYS_mremap, SYS_mprotect, SYS_madvise, SYS_futex, SYS_set_robust_list, SYS_set_tid_address, SYS_rseq,
    SYS_rt_sigaction, SYS_rt_sigprocmask, SYS_rt_sigreturn, SYS_rt_sigsuspend, SYS_rt_sigpending, SYS_rt_sigtimedwait, SYS_sigaltstack, SYS_restart_syscall,
    SYS_clock_gettime, SYS_clock_getres, SYS_clock_nanosleep, SYS_nanosleep, SYS_gettimeofday, SYS_times, SYS_getrusage, SYS_getitimer, SYS_setitimer,
    SYS_sched_yield, SYS_sched_getaffinity, SYS_getrandom, SYS_uname, SYS_prlimit64, SYS_prctl, SYS_getcpu,
    // processes
    SYS_execve, SYS_exit, SYS_exit_group, SYS_wait4, SYS_waitid, SYS_kill, SYS_tgkill, SYS_tkill,
    SYS_getpid, SYS_getppid, SYS_gettid, SYS_getpgid, SYS_setpgid, SYS_getsid, SYS_setsid,
    SYS_getuid, SYS_geteuid, SYS_getgid, SYS_getegid, SYS_getresuid, SYS_getresgid, SYS_getgroups,
    // files (all inside the sandbox's own mounts)
    SYS_read, SYS_write, SYS_readv, SYS_writev, SYS_pread64, SYS_pwrite64, SYS_preadv, SYS_pwritev, SYS_lseek, SYS_close, SYS_close_range,
    SYS_openat, SYS_newfstatat, SYS_fstat, SYS_statx, SYS_statfs, SYS_fstatfs, SYS_faccessat, SYS_faccessat2, SYS_readlinkat, SYS_getcwd, SYS_chdir, SYS_fchdir,
    SYS_getdents64, SYS_mkdirat, SYS_unlinkat, SYS_renameat, SYS_renameat2, SYS_linkat, SYS_symlinkat, SYS_fchmod, SYS_fchmodat, SYS_umask,
    SYS_ftruncate, SYS_truncate, SYS_fsync, SYS_fdatasync, SYS_fallocate, SYS_utimensat, SYS_flock, SYS_fadvise64, SYS_splice, SYS_sendfile, SYS_copy_file_range,
    SYS_getxattr, SYS_lgetxattr, SYS_fgetxattr, SYS_listxattr, SYS_llistxattr, SYS_flistxattr,
    SYS_dup, SYS_dup3, SYS_fcntl, SYS_ioctl, SYS_pipe2, SYS_ppoll, SYS_pselect6, SYS_epoll_create1, SYS_epoll_ctl, SYS_epoll_pwait, SYS_eventfd2,
    // AF_UNIX sockets only (socket itself is checked by family)
    SYS_socketpair, SYS_connect, SYS_bind, SYS_listen, SYS_accept4, SYS_sendto, SYS_recvfrom, SYS_sendmsg, SYS_recvmsg, SYS_shutdown,
    SYS_getsockname, SYS_getpeername, SYS_getsockopt, SYS_setsockopt,
  ];
  #[cfg(target_arch = "x86_64")]
  v.extend([SYS_arch_prctl, SYS_open, SYS_stat, SYS_lstat, SYS_access, SYS_readlink, SYS_mkdir, SYS_rmdir, SYS_unlink, SYS_rename, SYS_link, SYS_symlink,
    SYS_chmod, SYS_creat, SYS_getdents, SYS_dup2, SYS_pipe, SYS_poll, SYS_select, SYS_epoll_wait, SYS_fork, SYS_vfork, SYS_time, SYS_alarm, SYS_getpgrp, SYS_utimes, SYS_accept]);
  v
}

#[derive(Clone, Copy)]
enum To { Next, L(usize) }

enum Op { Ld(u32), Ret(u32), Jmp(u16, u32, To, To), Ja(usize), Label(usize) }

/// Compares the loaded syscall number against `nrs` in blocks, each followed by its own return,
/// so every conditional jump stays within BPF's 8-bit offsets.
fn block(ops: &mut Vec<Op>, labels: &mut usize, nrs: &[i64], ret: u32) {
  for chunk in nrs.chunks(100) {
    let (hit, past) = (*labels, *labels + 1);
    *labels += 2;
    for &nr in chunk { ops.push(Op::Jmp(JEQ_K, nr as u32, To::L(hit), To::Next)); }
    ops.extend([Op::Ja(past), Op::Label(hit), Op::Ret(ret), Op::Label(past)]);
  }
}

/// The filter as the `struct sock_filter` array bwrap reads from its `--seccomp` descriptor.
pub fn program() -> Vec<u8> {
  let (deny, nosys, clone, socket) = (0, 1, 2, 3);
  let mut labels = 4;
  let mut ops = vec![Op::Ld(OFF_ARCH), Op::Jmp(JEQ_K, ARCH, To::Next, To::L(deny)), Op::Ld(OFF_NR)];
  #[cfg(target_arch = "x86_64")]
  ops.push(Op::Jmp(JGE_K, 0x4000_0000, To::L(deny), To::Next)); // x32 ABI
  #[cfg(not(target_arch = "x86_64"))]
  let _ = JGE_K;
  let denied: Vec<i64> = denied().into_iter().map(|(_, nr)| nr).collect();
  block(&mut ops, &mut labels, &denied, RET_ERRNO | libc::EPERM as u32);
  ops.extend([
    Op::Jmp(JEQ_K, libc::SYS_clone3 as u32, To::L(nosys), To::Next),
    Op::Jmp(JEQ_K, libc::SYS_clone as u32, To::L(clone), To::Next),
    Op::Jmp(JEQ_K, libc::SYS_socket as u32, To::L(socket), To::Next),
  ]);
  block(&mut ops, &mut labels, &allowed(), RET_ALLOW);
  ops.extend([
    Op::Ja(nosys),
    Op::Label(clone), Op::Ld(OFF_ARG0), Op::Jmp(JSET_K, CLONE_NAMESPACES, To::L(deny), To::Next), Op::Ret(RET_ALLOW),
    Op::Label(socket), Op::Ld(OFF_ARG0), Op::Jmp(JEQ_K, libc::AF_UNIX as u32, To::Next, To::L(deny)), Op::Ret(RET_ALLOW),
    Op::Label(nosys), Op::Ret(RET_ERRNO | libc::ENOSYS as u32),
    Op::Label(deny), Op::Ret(RET_ERRNO | libc::EPERM as u32),
  ]);
  // Two passes: place labels, then emit with relative (always forward) jump offsets.
  let (mut pc, mut at) = (0usize, vec![usize::MAX; labels]);
  for op in &ops { match op { Op::Label(l) => at[*l] = pc, _ => pc += 1 } }
  let mut out = Vec::with_capacity(pc * 8);
  let mut emit = |code: u16, jt: u8, jf: u8, k: u32| { out.extend(code.to_ne_bytes()); out.push(jt); out.push(jf); out.extend(k.to_ne_bytes()); };
  let mut pc = 0usize;
  for op in &ops {
    let off = |l: usize| at[l].checked_sub(pc + 1).expect("seccomp jumps go forward");
    let rel = |t: To| -> u8 { match t { To::Next => 0, To::L(l) => u8::try_from(off(l)).expect("seccomp jump too long") } };
    match op {
      Op::Label(_) => continue,
      Op::Ld(k) => emit(LD_W_ABS, 0, 0, *k),
      Op::Ret(k) => emit(RET_K, 0, 0, *k),
      Op::Ja(l) => emit(JA, 0, 0, off(*l) as u32),
      Op::Jmp(c, k, t, f) => emit(*c, rel(*t), rel(*f), *k),
    }
    pc += 1;
  }
  out
}

#[cfg(test)]
mod tests {
  #[test]
  fn program_is_well_formed() {
    let p = super::program();
    assert_eq!(p.len() % 8, 0);
    assert!(p.len() / 8 < 4096, "BPF_MAXINSNS");
    let (allow, deny) = (super::allowed(), super::denied());
    assert!(deny.iter().all(|(n, nr)| !allow.contains(nr) || panic!("{n} is both allowed and denied")));
  }
}
