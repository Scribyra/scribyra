//! The WebAssembly half of a Scribyra plugin. It has no access to anything but the
//! memory it is given: no network, no project, no storage. Its only host import is
//! `env.log`, which src/main.js passes in. The JavaScript shim reads files through the
//! capability API, hands their text in, and shows the result.
//!
//! ABI (all offsets into this module's memory):
//!   alloc(len) -> ptr            reserve `len` bytes for input
//!   dealloc(ptr, len)            release them
//!   count_words(ptr, len) -> u32 words in the UTF-8 TeX text at ptr..ptr+len

#[link(wasm_import_module = "env")]
extern "C" {
    fn log(ptr: *const u8, len: usize);
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len);
    let ptr = buffer.as_mut_ptr();
    core::mem::forget(buffer);
    ptr
}

/// # Safety
/// `ptr` and `len` must come from `alloc`.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

/// # Safety
/// `ptr..ptr+len` must be initialised memory obtained from `alloc`.
#[no_mangle]
pub unsafe extern "C" fn count_words(ptr: *const u8, len: usize) -> u32 {
    let bytes = core::slice::from_raw_parts(ptr, len);
    let text = String::from_utf8_lossy(bytes);
    let mut count = 0u32;
    for line in text.lines() {
        // Drop comments: an unescaped % ends the line.
        let mut end = line.len();
        let mut escaped = false;
        for (index, ch) in line.char_indices() {
            if ch == '%' && !escaped {
                end = index;
                break;
            }
            escaped = ch == '\\' && !escaped;
        }
        let mut in_command = false;
        let mut in_word = false;
        for ch in line[..end].chars() {
            if ch == '\\' {
                in_command = true;
                in_word = false;
                continue;
            }
            if in_command {
                if ch.is_ascii_alphabetic() || ch == '@' {
                    continue;
                }
                in_command = false;
            }
            if ch.is_alphabetic() {
                if !in_word {
                    count += 1;
                    in_word = true;
                }
            } else if ch.is_whitespace() || "{}[]$&#^_~".contains(ch) {
                in_word = false;
            }
        }
    }
    let message = b"counted words";
    log(message.as_ptr(), message.len());
    count
}
