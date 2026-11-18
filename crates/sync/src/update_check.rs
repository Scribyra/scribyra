//! A strict validator for Yjs (lib0 v1) updates, run on every untrusted update before `yrs`
//! sees its bytes (review C1). `yrs` 0.25 trusts its input: it pre-allocates from length
//! varints (`Vec`/`HashMap::with_capacity` in `Any` arrays and maps and delete-set ranges, an
//! allocation abort no `catch_unwind` can stop), recurses through nested `Any` values without a
//! limit (a stack overflow, also an abort), builds strings with `from_utf8_unchecked`, and adds
//! clocks and ranges with overflowing arithmetic (a panic in debug builds).
//!
//! The walk mirrors `yrs`'s v1 decoder byte for byte (`Update::decode`, `ItemContent::decode`,
//! `Any::decode`, `TypeRef::decode`, `Move::decode`, `Options::decode`, `IdSet::decode`), so
//! `yrs` never reads a byte this module has not checked, and refuses: any length or count larger
//! than the bytes left, varints longer than their type (or that overflow it), nesting deeper than
//! [`MAX_DEPTH`], more than [`MAX_STRUCTS`] structs or [`MAX_DELETE_RANGES`] deleted ranges, an
//! estimated decoded size above [`MAX_DECODED_BYTES`], invalid UTF-8, clocks or ranges past
//! `u32::MAX`, unknown or reserved info bits and content kinds, and trailing bytes.
//!
//! Where `yrs` differs from Yjs, the walk follows `yrs` (what matters is what `yrs` will read):
//! legacy `ContentJSON` (kind 2) holds `len + 1` strings in `yrs`, and weak links (type 7) are
//! refused because this build has no `weak` feature.

/// Deepest nesting of `Any` arrays and maps.
pub const MAX_DEPTH: usize = 64;
/// Structs (items, GC and skip ranges) in one update.
pub const MAX_STRUCTS: u64 = 1 << 20;
/// Deleted ranges in one update's delete set.
pub const MAX_DELETE_RANGES: u64 = 1 << 20;
/// What decoding may allocate, estimated from the counts below.
pub const MAX_DECODED_BYTES: u64 = 256 << 20;
/// Estimated decoded cost of one struct (a boxed `Item` with its pointers and flags).
const STRUCT_COST: u64 = 256;
/// Estimated decoded cost of one `Any` value or map entry, besides its bytes.
const ANY_COST: u64 = 64;

const SKIP: u8 = 10;
const GC: u8 = 0;
const HAS_ORIGIN: u8 = 0b1000_0000;
const HAS_RIGHT_ORIGIN: u8 = 0b0100_0000;
const HAS_PARENT_SUB: u8 = 0b0010_0000;
/// Bit 4 of the info byte is unused by Yjs and ignored by `yrs`; refused here.
const RESERVED: u8 = 0b0001_0000;

/// Why an update was refused (fixed codes, safe to log).
pub type Invalid = &'static str;

struct Walk<'a> {
    bytes: &'a [u8],
    at: usize,
    structs: u64,
    ranges: u64,
    decoded: u64,
}

impl<'a> Walk<'a> {
    fn left(&self) -> usize {
        self.bytes.len() - self.at
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], Invalid> {
        if n > self.left() {
            return Err("truncated");
        }
        let out = &self.bytes[self.at..self.at + n];
        self.at += n;
        Ok(out)
    }
    fn u8(&mut self) -> Result<u8, Invalid> {
        Ok(self.take(1)?[0])
    }
    fn charge(&mut self, bytes: u64) -> Result<(), Invalid> {
        self.decoded = self.decoded.saturating_add(bytes);
        if self.decoded > MAX_DECODED_BYTES {
            return Err("too large when decoded");
        }
        Ok(())
    }
    /// An unsigned varint of at most `max_bytes` bytes whose value fits in `bits` bits.
    fn var(&mut self, max_bytes: usize, bits: u32) -> Result<u64, Invalid> {
        let mut value: u64 = 0;
        for i in 0..max_bytes {
            let b = self.u8()?;
            let part = u64::from(b & 0x7f);
            let shift = 7 * i as u32;
            if shift >= 64 || (shift > 0 && part >> (64 - shift) != 0) {
                return Err("varint overflow");
            }
            value |= part << shift;
            if b & 0x80 == 0 {
                if bits < 64 && value >> bits != 0 {
                    return Err("varint overflow");
                }
                return Ok(value);
            }
        }
        Err("varint too long")
    }
    fn u32(&mut self) -> Result<u32, Invalid> {
        Ok(self.var(5, 32)? as u32)
    }
    fn u64(&mut self) -> Result<u64, Invalid> {
        self.var(10, 64)
    }
    /// A signed varint (lib0 `writeVarInt`): `yrs` shifts a 64-bit value by up to 69 bits and
    /// negates it, so only 9 bytes (62 bits of magnitude) are accepted; Yjs writes at most 8.
    fn signed(&mut self) -> Result<i64, Invalid> {
        let first = self.u8()?;
        let negative = first & 0x40 != 0;
        let mut value = u64::from(first & 0x3f);
        let mut more = first & 0x80 != 0;
        let mut shift = 6;
        while more {
            if shift > 6 + 7 * 7 {
                return Err("varint too long");
            }
            let b = self.u8()?;
            value |= u64::from(b & 0x7f) << shift;
            more = b & 0x80 != 0;
            shift += 7;
        }
        let value = value as i64;
        Ok(if negative { -value } else { value })
    }
    /// A length-prefixed byte buffer (`read_buf`: u32 length).
    fn buf(&mut self) -> Result<&'a [u8], Invalid> {
        let n = self.u32()? as usize;
        let out = self.take(n)?;
        self.charge(out.len() as u64)?;
        Ok(out)
    }
    /// A length-prefixed UTF-8 string; returns its length in UTF-16 code units.
    fn string(&mut self) -> Result<u64, Invalid> {
        let text = std::str::from_utf8(self.buf()?).map_err(|_| "invalid UTF-8")?;
        Ok(text.encode_utf16().count() as u64)
    }
    /// A count of things that each take at least `min` bytes, refused when the bytes left
    /// cannot hold that many (so nothing is ever reserved from an unchecked count).
    fn count(&self, n: u64, min: u64) -> Result<u64, Invalid> {
        if n.saturating_mul(min) > self.left() as u64 {
            return Err("count larger than the update");
        }
        Ok(n)
    }
    fn id(&mut self) -> Result<(), Invalid> {
        self.u32()?;
        self.u32()?;
        Ok(())
    }

    fn any(&mut self, depth: usize) -> Result<(), Invalid> {
        if depth > MAX_DEPTH {
            return Err("nested too deeply");
        }
        self.charge(ANY_COST)?;
        match self.u8()? {
            127 | 126 | 121 | 120 => {}
            125 => {
                self.signed()?;
            }
            124 => {
                self.take(4)?;
            }
            123 | 122 => {
                self.take(8)?;
            }
            119 => {
                self.string()?;
            }
            118 => {
                let raw = self.u64()?;
                let n = self.count(raw, 2)?;
                self.charge(n.saturating_mul(ANY_COST))?;
                for _ in 0..n {
                    self.string()?;
                    self.any(depth + 1)?;
                }
            }
            117 => {
                let raw = self.u64()?;
                let n = self.count(raw, 1)?;
                self.charge(n.saturating_mul(ANY_COST))?;
                for _ in 0..n {
                    self.any(depth + 1)?;
                }
            }
            116 => {
                self.buf()?;
            }
            _ => return Err("unknown value type"),
        }
        Ok(())
    }

    /// One item's content; returns its length (how far it moves the client's clock).
    fn content(&mut self, kind: u8) -> Result<u64, Invalid> {
        Ok(match kind {
            // Deleted: a length only.
            1 => u64::from(self.u32()?),
            // JSON (legacy): `yrs` reads len + 1 strings.
            2 => {
                let raw = u64::from(self.u32()?);
                let n = self.count(raw + 1, 1)?;
                self.charge(n.saturating_mul(ANY_COST))?;
                for _ in 0..n {
                    self.string()?;
                }
                n
            }
            // Binary.
            3 => {
                self.buf()?;
                1
            }
            // String: its length in UTF-16 code units.
            4 => self.string()?,
            // Embed (JSON text).
            5 => {
                self.string()?;
                1
            }
            // Format: key and JSON text.
            6 => {
                self.string()?;
                self.string()?;
                1
            }
            // Type: array, map, text, XML fragment, hook, text, sub-document, undefined; an XML
            // element has a name. Weak links (7) need a feature this build does not have.
            7 => {
                match self.u8()? {
                    0 | 1 | 2 | 4 | 5 | 6 | 9 | 15 => {}
                    3 => {
                        self.string()?;
                    }
                    _ => return Err("unknown type"),
                }
                1
            }
            // Any values.
            8 => {
                let raw = u64::from(self.u32()?);
                let n = self.count(raw, 1)?;
                for _ in 0..n {
                    self.any(1)?;
                }
                n
            }
            // Sub-document: GUID and options.
            9 => {
                self.string()?;
                self.any(1)?;
                1
            }
            // Move: signed flags (an i32), start ID (u64 client, u32 clock), end ID unless collapsed.
            11 => {
                let flags = self.signed()?;
                if i32::try_from(flags).is_err() {
                    return Err("varint overflow");
                }
                self.u64()?;
                self.u32()?;
                if flags & 1 == 0 {
                    self.u64()?;
                    self.u32()?;
                }
                1
            }
            _ => return Err("unknown content kind"),
        })
    }

    fn block(&mut self) -> Result<u64, Invalid> {
        self.structs += 1;
        if self.structs > MAX_STRUCTS {
            return Err("too many structs");
        }
        self.charge(STRUCT_COST)?;
        let info = self.u8()?;
        match info {
            SKIP | GC => return Ok(u64::from(self.u32()?)),
            _ => {}
        }
        if info & RESERVED != 0 {
            return Err("reserved info bits");
        }
        if info & HAS_ORIGIN != 0 {
            self.id()?;
        }
        if info & HAS_RIGHT_ORIGIN != 0 {
            self.id()?;
        }
        if info & (HAS_ORIGIN | HAS_RIGHT_ORIGIN) == 0 {
            match self.u32()? {
                1 => {
                    self.string()?;
                }
                0 => self.id()?,
                _ => return Err("invalid parent"),
            }
            if info & HAS_PARENT_SUB != 0 {
                self.string()?;
            }
        }
        self.content(info & 0b1111)
    }

    fn update(&mut self) -> Result<(), Invalid> {
        let raw = u64::from(self.u32()?);
        let clients = self.count(raw, 3)?;
        for _ in 0..clients {
            let raw = u64::from(self.u32()?);
            let blocks = self.count(raw, 2)?;
            self.u32()?;
            let mut clock = u64::from(self.u32()?);
            for _ in 0..blocks {
                clock += self.block()?;
                if clock > u64::from(u32::MAX) {
                    return Err("clock overflow");
                }
            }
        }
        // The delete set: per client, one range or a list of ranges (clock, length).
        let raw = u64::from(self.u32()?);
        let clients = self.count(raw, 2)?;
        for _ in 0..clients {
            self.u32()?;
            let raw = u64::from(self.u32()?);
            let ranges = self.count(raw, 2)?;
            self.ranges += ranges;
            if self.ranges > MAX_DELETE_RANGES {
                return Err("too many deleted ranges");
            }
            self.charge(ranges.saturating_mul(8))?;
            for _ in 0..ranges {
                let (start, len) = (self.u32()?, self.u32()?);
                if start.checked_add(len).is_none() {
                    return Err("range overflow");
                }
            }
        }
        if self.left() != 0 {
            return Err("trailing bytes");
        }
        Ok(())
    }
}

/// Checks that `bytes` is one well-formed Yjs v1 update within this module's limits.
pub fn check(bytes: &[u8]) -> Result<(), Invalid> {
    Walk { bytes, at: 0, structs: 0, ranges: 0, decoded: 0 }.update()
}

/// [`check`], then `yrs`'s own decoder, then applying the update to an empty document (both
/// inside `catch_unwind`): `yrs` panics while integrating some self-contradictory updates, and
/// one stored in a log would fail every later replay of that project.
pub fn decodes(bytes: &[u8]) -> bool {
    use yrs::{Doc, Options, Transact, Update, updates::decoder::Decode};
    check(bytes).is_ok()
        && std::panic::catch_unwind(|| {
            let Ok(update) = Update::decode_v1(bytes) else { return false };
            let doc = Doc::with_options(Options { skip_gc: true, ..Options::default() });
            let mut txn = doc.transact_mut();
            txn.apply_update(update).is_ok()
        })
        .unwrap_or(false)
}
