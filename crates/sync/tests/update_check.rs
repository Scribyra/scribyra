//! The Yjs update validator in-process (review C1): every update `yrs` writes passes, hostile
//! lengths, nesting, strings, clocks and trailing bytes are refused, and random mutations and
//! truncations of real updates never make the validator or `yrs` (after the validator accepted
//! the bytes) panic, abort or overflow the stack.
use scribyra_sync::update_check::{MAX_DEPTH, check, decodes};
use std::{collections::HashMap, sync::Arc};
use yrs::{Any, Array, Doc, GetString, Map, ReadTxn, StateVector, Text, Transact, Update, Xml, XmlFragment, updates::decoder::Decode};

fn var(mut n: u64) -> Vec<u8> {
    let mut out = Vec::new();
    while n >= 0x80 {
        out.push((n as u8 & 0x7f) | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
    out
}
/// One `Any` item of the root map `t`, then an empty delete set.
fn any_item(value: &[u8]) -> Vec<u8> {
    [&[1, 1, 1, 0, 8, 1, 1, b't', 1][..], value, &[0]].concat()
}
fn nested(depth: usize) -> Vec<u8> {
    let mut value = [117, 1].repeat(depth);
    value.push(126);
    value
}

/// A small deterministic generator (xorshift64*), so a failure reproduces.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

/// Updates `yrs` writes for documents shaped like the app's and beyond: maps of nested values,
/// texts with formatting, embeds and deletions, arrays, XML, sub-documents and several clients.
fn real_updates() -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let a = Doc::with_client_id(1);
    let b = Doc::with_client_id(2);
    let (files, text, list, xml) = (a.get_or_insert_map("files"), a.get_or_insert_text("text:f1"), a.get_or_insert_array("list"), a.get_or_insert_xml_fragment("xml"));
    let mut record: HashMap<String, Any> = HashMap::new();
    record.insert("id".into(), Any::from("f1"));
    record.insert("name".into(), Any::from("main.tex"));
    record.insert("size".into(), Any::Number(1.5));
    record.insert("count".into(), Any::BigInt(-7));
    record.insert("n".into(), Any::Number(-123456.0));
    record.insert("bytes".into(), Any::Buffer(Arc::from(&b"\x00\x01\xff"[..])));
    record.insert("list".into(), Any::Array(Arc::from(vec![Any::Null, Any::Undefined, Any::Bool(true), Any::from("é ✓ 𝄞")])));
    let record = Any::Map(Arc::new(record));
    for step in 0..6 {
        let mut txn = a.transact_mut();
        match step {
            0 => {
                files.insert(&mut txn, "f1", record.clone());
                text.insert(&mut txn, 0, "\\documentclass{article} 𝄞 é");
            }
            1 => {
                let attrs: HashMap<Arc<str>, Any> = HashMap::from([(Arc::from("bold"), Any::Bool(true))]);
                text.format(&mut txn, 2, 5, attrs);
                text.insert_embed(&mut txn, 3, Any::from("embedded"));
                text.remove_range(&mut txn, 0, 2);
            }
            2 => {
                list.insert_range(&mut txn, 0, [Any::from(1.0), Any::from("two"), record.clone()]);
                let inner = list.insert(&mut txn, 3, yrs::MapPrelim::default());
                inner.insert(&mut txn, "deep", record.clone());
            }
            3 => {
                let el = xml.insert(&mut txn, 0, yrs::XmlElementPrelim::empty("p"));
                el.insert_attribute(&mut txn, "class", "x");
                xml.insert(&mut txn, 1, yrs::XmlTextPrelim::new("hello"));
            }
            4 => {
                files.insert(&mut txn, "sub", yrs::Doc::new());
                files.remove(&mut txn, "f1");
                list.remove(&mut txn, 1);
            }
            _ => {
                text.insert(&mut txn, 0, &"long text ".repeat(50));
            }
        }
        out.push(txn.encode_update_v1());
    }
    // Another client's concurrent edits, merged.
    {
        let t = b.get_or_insert_text("text:f1");
        let mut txn = b.transact_mut();
        t.insert(&mut txn, 0, "other");
        out.push(txn.encode_update_v1());
    }
    for u in &out {
        b.transact_mut().apply_update(Update::decode_v1(u).unwrap()).unwrap();
    }
    out.push(b.transact().encode_state_as_update_v1(&StateVector::default()));
    out.push(a.transact().encode_state_as_update_v1(&StateVector::default()));
    out.push(Doc::new().transact().encode_state_as_update_v1(&StateVector::default()));
    assert_eq!(b.get_or_insert_text("text:f1").get_string(&b.transact()).len() > 500, true);
    out
}

#[test]
fn every_update_yrs_writes_passes() {
    for (n, update) in real_updates().iter().enumerate() {
        assert_eq!(check(update), Ok(()), "update {n}");
        assert!(decodes(update), "update {n}");
    }
}

#[test]
fn hostile_updates_are_refused_before_yrs_sees_them() {
    for (what, update, reason) in [
        ("array of 2^36", any_item(&[&[117][..], &var(1 << 36)].concat()), "count larger than the update"),
        ("array of 2^50", any_item(&[&[117][..], &var(1 << 50)].concat()), "count larger than the update"),
        ("map of 2^40", any_item(&[&[118][..], &var(1 << 40)].concat()), "count larger than the update"),
        ("2^32 Any items", [&[1, 1, 1, 0, 8, 1, 1, b't'][..], &var(u32::MAX as u64), &[126, 0]].concat(), "count larger than the update"),
        ("a million nested arrays", any_item(&nested(1_000_000)), "nested too deeply"),
        ("one level too deep", any_item(&nested(MAX_DEPTH)), "nested too deeply"),
        ("invalid UTF-8 string content", vec![1, 1, 1, 0, 4, 1, 1, b't', 2, 0xff, 0xfe, 0], "invalid UTF-8"),
        ("invalid UTF-8 root name", vec![1, 1, 1, 0, 4, 1, 1, 0xc3, 1, b'x', 0], "invalid UTF-8"),
        ("invalid UTF-8 map key", any_item(&[118, 1, 1, 0x80, 126]), "invalid UTF-8"),
        ("string longer than the update", vec![1, 1, 1, 0, 4, 1, 1, b't', 0x80, 0x80, 0x04, b'x', 0], "truncated"),
        ("2^32 clients", [var(u32::MAX as u64), vec![0]].concat(), "count larger than the update"),
        ("2^32 delete-set ranges", [&[0, 1, 1][..], &var(u32::MAX as u64), &[0, 0]].concat(), "count larger than the update"),
        ("deleted range past u32::MAX", [&[0, 1, 1, 1][..], &var(u32::MAX as u64), &[1]].concat(), "range overflow"),
        ("clock past u32::MAX", [&[1, 2, 1][..], &var(u32::MAX as u64 - 1), &[0, 1, 0, 1, 0]].concat(), "clock overflow"),
        ("a varint of 6 bytes for a u32", vec![1, 1, 1, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00, 0, 1, 0], "varint too long"),
        ("a u32 varint past 2^32", [&[1, 1, 1][..], &var(1 << 33), &[0, 1, 0]].concat(), "varint overflow"),
        ("a signed varint of 11 bytes", any_item(&[125, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]), "varint too long"),
        ("unknown Any type", any_item(&[115]), "unknown value type"),
        ("unknown content kind", vec![1, 1, 1, 0, 12, 1, 1, b't', 0], "unknown content kind"),
        ("reserved info bit", vec![1, 1, 1, 0, 0x14, 1, 1, b't', 1, b'x', 0], "reserved info bits"),
        ("weak link type", vec![1, 1, 1, 0, 7, 1, 1, b't', 7, 0], "unknown type"),
        ("parent info 2", vec![1, 1, 1, 0, 4, 2, 0, 0, 1, b'x', 0], "invalid parent"),
        ("trailing byte", [any_item(&[126]), vec![0]].concat(), "trailing bytes"),
        ("empty", vec![], "truncated"),
        ("missing delete set", vec![0], "truncated"),
    ] {
        assert_eq!(check(&update), Err(reason), "{what}");
        assert!(!decodes(&update), "{what}");
    }
    // At the limit is fine; so are the same shapes with honest lengths.
    assert_eq!(check(&any_item(&nested(MAX_DEPTH - 1))), Ok(()));
    assert_eq!(check(&vec![1, 1, 1, 0, 4, 1, 1, b't', 2, b'o', b'k', 0]), Ok(()));
    assert_eq!(check(&any_item(&[125, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f])), Ok(()));
    assert!(decodes(&any_item(&[118, 1, 1, b'k', 117, 2, 119, 1, b'v', 116, 1, 9])));
}

/// The struct and decoded-size caps hold even when every count is honest.
#[test]
fn honest_but_huge_updates_are_capped() {
    // 1.1 million GC structs of one clock each (2 bytes apiece).
    let n = (scribyra_sync::update_check::MAX_STRUCTS + 1) as usize;
    let mut update = [&[1][..], &var(n as u64), &[1, 0]].concat();
    for _ in 0..n {
        update.extend_from_slice(&[0, 1]);
    }
    update.push(0);
    assert!(matches!(check(&update), Err("too many structs") | Err("too large when decoded")));
    // Five million tiny Any values in one item: honest counts, too much memory once decoded.
    let mut values = [&[1, 1, 1, 0, 8, 1, 1, b't'][..], &var(5_000_000)].concat();
    values.extend(std::iter::repeat_n(126, 5_000_000));
    values.push(0);
    assert_eq!(check(&values), Err("too large when decoded"));
}

/// Random mutations and truncations of real updates: the validator never panics, and whenever
/// it accepts the bytes, `yrs` decodes them without panicking. Applying a decoded update may
/// still panic inside `yrs` (an origin that names a missing item, for example): that is a
/// panic, not an abort, and the server's replay catches it; here it must not abort or hang.
#[test]
fn mutated_updates_never_crash_the_decoder() {
    let updates = real_updates();
    let mut rng = Rng(0x5eed_1234_abcd_0001);
    let (mut accepted, mut tried, mut integrate_panics) = (0, 0, 0);
    let hook = std::panic::take_hook();
    for round in 0..40_000 {
        let base = &updates[round % updates.len()];
        let mut bytes = base.clone();
        for _ in 0..1 + rng.below(4) {
            match rng.below(7) {
                0 if !bytes.is_empty() => {
                    let i = rng.below(bytes.len());
                    bytes[i] ^= 1 << rng.below(8);
                }
                1 if !bytes.is_empty() => {
                    let i = rng.below(bytes.len());
                    bytes[i] = rng.next() as u8;
                }
                2 => {
                    let i = rng.below(bytes.len() + 1);
                    bytes.truncate(i);
                }
                3 => {
                    let i = rng.below(bytes.len() + 1);
                    bytes.insert(i, rng.next() as u8);
                }
                4 if !bytes.is_empty() => {
                    let i = rng.below(bytes.len());
                    bytes.remove(i);
                }
                5 if !bytes.is_empty() => {
                    // A large length where a small one was.
                    let i = rng.below(bytes.len());
                    let big = var(1 << (20 + rng.below(40)));
                    bytes.splice(i..i + 1, big);
                }
                _ => {
                    let i = rng.below(bytes.len() + 1);
                    let j = (i + rng.below(16)).min(bytes.len());
                    let chunk = bytes[i..j].to_vec();
                    bytes.splice(i..i, chunk);
                }
            }
        }
        tried += 1;
        if check(&bytes).is_err() {
            continue;
        }
        accepted += 1;
        // No `catch_unwind` around decoding: a panic there after the check fails the test.
        if let Ok(update) = Update::decode_v1(&bytes) {
            std::panic::set_hook(Box::new(|_| {}));
            let applied = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let doc = Doc::with_options(yrs::Options { skip_gc: true, ..yrs::Options::default() });
                let _ = doc.transact_mut().apply_update(update);
                let _ = doc.transact().encode_state_as_update_v1(&StateVector::default());
            }));
            let _ = std::panic::take_hook();
            integrate_panics += usize::from(applied.is_err());
        }
    }
    std::panic::set_hook(hook);
    println!("{accepted} of {tried} mutations accepted; {integrate_panics} panicked while integrating");
    assert!(accepted > 100 && accepted < tried, "{accepted} of {tried} accepted");
}
