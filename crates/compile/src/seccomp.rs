//! The seccomp-BPF filter every sandboxed process runs under (design section 6). Built by hand:
//! a deny list answered with `EPERM`, `clone` refused when it asks for any namespace, `clone3`
//! answered with `ENOSYS` (its flags sit behind a pointer the filter cannot read, so libc falls
//! back to `clone`), `socket` allowed for `AF_UNIX` only, and every foreign ABI (i386, x32)
//! refused outright. bwrap loads it (`--seccomp FD`, with `no_new_privs`) just before the exec.

const LD_W_ABS: u16 = 0x20; // BPF_LD | BPF_W | BPF_ABS
const JEQ_K: u16 = 0x15; // BPF_JMP | BPF_JEQ | BPF_K
const JGE_K: u16 = 0x35; // BPF_JMP | BPF_JGE | BPF_K
const JSET_K: u16 = 0x45; // BPF_JMP | BPF_JSET | BPF_K
const RET_K: u16 = 0x06; // BPF_RET | BPF_K
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
  ];
  #[cfg(target_arch = "x86_64")]
  v.extend([("iopl", SYS_iopl), ("ioperm", SYS_ioperm), ("uselib", SYS_uselib), ("lookup_dcookie", SYS_lookup_dcookie)]);
  v
}

#[derive(Clone, Copy)]
enum To { Next, Deny, Nosys, Clone, Socket }

enum Op { Ld(u32), Ret(u32), Jmp(u16, u32, To, To), Label(To) }

/// The filter as the `struct sock_filter` array bwrap reads from its `--seccomp` descriptor.
pub fn program() -> Vec<u8> {
  let mut ops = vec![Op::Ld(OFF_ARCH), Op::Jmp(JEQ_K, ARCH, To::Next, To::Deny), Op::Ld(OFF_NR)];
  #[cfg(target_arch = "x86_64")]
  ops.push(Op::Jmp(JGE_K, 0x4000_0000, To::Deny, To::Next)); // x32 ABI
  #[cfg(not(target_arch = "x86_64"))]
  let _ = JGE_K;
  for (_, nr) in denied() { ops.push(Op::Jmp(JEQ_K, nr as u32, To::Deny, To::Next)); }
  ops.extend([
    Op::Jmp(JEQ_K, libc::SYS_clone3 as u32, To::Nosys, To::Next),
    Op::Jmp(JEQ_K, libc::SYS_clone as u32, To::Clone, To::Next),
    Op::Jmp(JEQ_K, libc::SYS_socket as u32, To::Socket, To::Next),
    Op::Ret(RET_ALLOW),
    Op::Label(To::Clone), Op::Ld(OFF_ARG0), Op::Jmp(JSET_K, CLONE_NAMESPACES, To::Deny, To::Next), Op::Ret(RET_ALLOW),
    Op::Label(To::Socket), Op::Ld(OFF_ARG0), Op::Jmp(JEQ_K, libc::AF_UNIX as u32, To::Next, To::Deny), Op::Ret(RET_ALLOW),
    Op::Label(To::Nosys), Op::Ret(RET_ERRNO | libc::ENOSYS as u32),
    Op::Label(To::Deny), Op::Ret(RET_ERRNO | libc::EPERM as u32),
  ]);
  // Two passes: place labels, then emit with relative (always forward) jump offsets.
  let (mut pc, mut at) = (0usize, [0usize; 5]);
  for op in &ops { match op { Op::Label(t) => at[*t as usize] = pc, _ => pc += 1 } }
  let mut out = Vec::with_capacity(pc * 8);
  let mut emit = |code: u16, jt: u8, jf: u8, k: u32| { out.extend(code.to_ne_bytes()); out.push(jt); out.push(jf); out.extend(k.to_ne_bytes()); };
  let mut pc = 0usize;
  for op in &ops {
    let rel = |t: To| -> u8 { if let To::Next = t { 0 } else { u8::try_from(at[t as usize] - pc - 1).expect("seccomp jump too long") } };
    match op {
      Op::Label(_) => continue,
      Op::Ld(k) => emit(LD_W_ABS, 0, 0, *k),
      Op::Ret(k) => emit(RET_K, 0, 0, *k),
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
    assert!(p.len() / 8 < 255, "jumps must stay within u8 offsets");
  }
}
