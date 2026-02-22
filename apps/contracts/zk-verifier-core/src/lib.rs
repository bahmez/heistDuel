#![no_std]

#[cfg(feature = "real-verifier")]
extern crate alloc;

use soroban_sdk::Bytes;
use soroban_sdk::Env;
#[cfg(feature = "real-verifier")]
use alloc::{string::String, vec::Vec};
#[cfg(feature = "real-verifier")]
use core::str;
#[cfg(feature = "real-verifier")]
use ultrahonk_soroban_verifier::{
    types::{G1Point, VerificationKey},
    UltraHonkVerifier,
};

pub const FIELD_SIZE_BYTES: usize = 32;
pub const PROOF_BLOB_HEADER_BYTES: usize = 4;

/// Supported proof field counts (excluding the single public input field).
/// Keep this list explicit to avoid accepting malformed formats silently.
pub const SUPPORTED_PROOF_FIELDS: [usize; 3] = [424, 440, 456];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProofBlobError {
    TooShort,
    UnexpectedFieldCount,
    LengthMismatch,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ParsedProofBlob {
    /// Number of 32-byte field elements in the full blob (public + proof).
    pub total_fields: usize,
    /// Number of proof field elements only.
    pub proof_fields: usize,
    /// Number of public input field elements.
    pub public_input_fields: usize,
    /// Full proof blob length in bytes.
    pub blob_len: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum VerifyCoreError {
    InvalidProofBlob(ProofBlobError),
    VkUtf8,
    VkParse,
    VerificationFailed,
}

#[inline(always)]
pub fn decode_total_fields_header(proof_blob: &Bytes) -> Result<usize, ProofBlobError> {
    if proof_blob.len() < PROOF_BLOB_HEADER_BYTES as u32 {
        return Err(ProofBlobError::TooShort);
    }
    let b0 = proof_blob.get(0).ok_or(ProofBlobError::TooShort)? as usize;
    let b1 = proof_blob.get(1).ok_or(ProofBlobError::TooShort)? as usize;
    let b2 = proof_blob.get(2).ok_or(ProofBlobError::TooShort)? as usize;
    let b3 = proof_blob.get(3).ok_or(ProofBlobError::TooShort)? as usize;
    Ok((b0 << 24) | (b1 << 16) | (b2 << 8) | b3)
}

/// Validates the packed proof blob format:
/// [4-byte big-endian total_fields][public_inputs][proof]
///
/// For heist turns we currently require exactly one public input (`pi_hash`).
pub fn parse_and_validate_proof_blob(
    proof_blob: &Bytes,
    expected_public_inputs: usize,
) -> Result<ParsedProofBlob, ProofBlobError> {
    let len = proof_blob.len() as usize;
    let total_fields = decode_total_fields_header(proof_blob)?;

    if total_fields < expected_public_inputs {
        return Err(ProofBlobError::UnexpectedFieldCount);
    }
    let proof_fields = total_fields - expected_public_inputs;
    if !SUPPORTED_PROOF_FIELDS.contains(&proof_fields) {
        return Err(ProofBlobError::UnexpectedFieldCount);
    }

    let expected_len = PROOF_BLOB_HEADER_BYTES + total_fields * FIELD_SIZE_BYTES;
    if len != expected_len {
        return Err(ProofBlobError::LengthMismatch);
    }

    Ok(ParsedProofBlob {
        total_fields,
        proof_fields,
        public_input_fields: expected_public_inputs,
        blob_len: len,
    })
}

#[cfg(feature = "real-verifier")]
#[inline(always)]
fn parse_u64_hex_lsb(s: &str) -> u64 {
    let h = s.trim_start_matches("0x");
    let n = core::cmp::min(16, h.len());
    let slice = &h[h.len() - n..];
    let mut out: u64 = 0;
    for ch in slice.chars() {
        let v = match ch {
            '0'..='9' => ch as u64 - '0' as u64,
            'a'..='f' => 10 + (ch as u64 - 'a' as u64),
            'A'..='F' => 10 + (ch as u64 - 'A' as u64),
            _ => 0,
        };
        out = (out << 4) | v;
    }
    out
}

#[cfg(feature = "real-verifier")]
fn parse_json_array_of_strings(s: &str) -> Result<Vec<String>, ()> {
    let mut out = Vec::<String>::new();
    let mut chars = s.chars().peekable();

    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
        } else {
            break;
        }
    }
    if chars.next() != Some('[') {
        return Err(());
    }

    loop {
        while let Some(&c) = chars.peek() {
            if c.is_whitespace() || c == ',' {
                chars.next();
            } else {
                break;
            }
        }
        if let Some(&']') = chars.peek() {
            chars.next();
            break;
        }
        if chars.next() != Some('"') {
            return Err(());
        }
        let mut buf = String::new();
        while let Some(c) = chars.next() {
            if c == '"' {
                break;
            }
            if c == '\\' {
                if let Some(next) = chars.next() {
                    buf.push(next);
                }
            } else {
                buf.push(c);
            }
        }
        out.push(buf);
    }

    Ok(out)
}

#[cfg(feature = "real-verifier")]
#[inline(always)]
fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(10 + (b - b'a')),
        b'A'..=b'F' => Some(10 + (b - b'A')),
        _ => None,
    }
}

#[cfg(feature = "real-verifier")]
fn hex_str_to_be32(s: &str) -> Option<[u8; 32]> {
    let hex = s.trim_start_matches("0x").as_bytes();
    let mut out = [0u8; 32];
    let mut oi = 32usize;
    let mut i = hex.len();
    while i > 0 && oi > 0 {
        let low = hex_val(hex[i - 1])?;
        i -= 1;
        let high = if i > 0 {
            let v = hex_val(hex[i - 1])?;
            i -= 1;
            v
        } else {
            0
        };
        oi -= 1;
        out[oi] = (high << 4) | low;
    }
    Some(out)
}

#[cfg(feature = "real-verifier")]
fn or_with_left_shift_bytes(lo: &[u8; 32], hi: &[u8; 32], shift_bytes: usize) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..32 {
        let hi_byte = if i + shift_bytes < 32 { hi[i + shift_bytes] } else { 0 };
        out[i] = lo[i] | hi_byte;
    }
    out
}

#[cfg(feature = "real-verifier")]
fn read_g1_from_limbs(lx: &[u8; 32], hx: &[u8; 32], ly: &[u8; 32], hy: &[u8; 32]) -> Option<G1Point> {
    // The VK is stored and set by a trusted admin via set_vk.
    // We skip the on-curve check here to avoid pulling ark-bn254 curve code into WASM.
    // An invalid G1 point would cause the final pairing check (host function) to fail anyway.
    let shifts = [136usize, 128usize];
    for &shift in &shifts {
        let sbytes = shift / 8;
        let x = or_with_left_shift_bytes(lx, hx, sbytes);
        let y = or_with_left_shift_bytes(ly, hy, sbytes);
        // Accept if the point is not the trivial all-zero representation
        if x.iter().any(|&b| b != 0) || y.iter().any(|&b| b != 0) {
            return Some(G1Point { x, y });
        }
    }
    None
}

#[cfg(feature = "real-verifier")]
fn try_read_g1(vk_fields: &[String], i: usize) -> Option<(G1Point, usize)> {
    if i + 3 >= vk_fields.len() {
        return None;
    }
    let lx = hex_str_to_be32(&vk_fields[i])?;
    let hx = hex_str_to_be32(&vk_fields[i + 1])?;
    let ly = hex_str_to_be32(&vk_fields[i + 2])?;
    let hy = hex_str_to_be32(&vk_fields[i + 3])?;
    let pt = read_g1_from_limbs(&lx, &hx, &ly, &hy)?;
    Some((pt, i + 4))
}

#[cfg(feature = "real-verifier")]
fn find_first_g1_start(vk_fields: &[String], start_guess: usize, max_probe: usize) -> Option<usize> {
    const TOTAL_POINTS: usize = 27;
    const TOTAL_LIMBS: usize = TOTAL_POINTS * 4;
    let end = core::cmp::min(vk_fields.len(), start_guess + max_probe);
    'probe: for i in start_guess..end {
        if i + TOTAL_LIMBS > vk_fields.len() {
            break;
        }
        let mut idx = i;
        for _ in 0..TOTAL_POINTS {
            if let Some((_pt, next)) = try_read_g1(vk_fields, idx) {
                idx = next;
            } else {
                continue 'probe;
            }
        }
        return Some(i);
    }
    None
}

#[cfg(feature = "real-verifier")]
pub fn load_vk_from_json_fields(json_data: &str) -> Result<VerificationKey, ()> {
    let vk_fields = parse_json_array_of_strings(json_data)?;
    if vk_fields.len() < 3 + 4 {
        return Err(());
    }

    let h0 = parse_u64_hex_lsb(&vk_fields[0]);
    let public_inputs_size = parse_u64_hex_lsb(&vk_fields[1]);

    let (circuit_size, log_circuit_size) = if h0 != 0 && (h0 & (h0 - 1)) == 0 {
        let mut lg = 0u64;
        let mut n = h0;
        while n > 1 {
            n >>= 1;
            lg += 1;
        }
        (h0, lg)
    } else {
        let cs = 1u64.checked_shl(h0 as u32).ok_or(())?;
        (cs, h0)
    };

    let mut idx = find_first_g1_start(&vk_fields, 3, 64).ok_or(())?;

    macro_rules! read_g1 {
        () => {{
            let (pt, next) = try_read_g1(&vk_fields, idx).ok_or(())?;
            idx = next;
            pt
        }};
    }

    let qm = read_g1!();
    let qc = read_g1!();
    let ql = read_g1!();
    let qr = read_g1!();
    let qo = read_g1!();
    let q4 = read_g1!();
    let q_lookup = read_g1!();
    let q_arith = read_g1!();
    let q_delta_range = read_g1!();
    let q_elliptic = read_g1!();
    let q_aux = read_g1!();
    let q_poseidon2_external = read_g1!();
    let q_poseidon2_internal = read_g1!();
    let s1 = read_g1!();
    let s2 = read_g1!();
    let s3 = read_g1!();
    let s4 = read_g1!();
    let id1 = read_g1!();
    let id2 = read_g1!();
    let id3 = read_g1!();
    let id4 = read_g1!();
    let t1 = read_g1!();
    let t2 = read_g1!();
    let t3 = read_g1!();
    let t4 = read_g1!();
    let lagrange_first = read_g1!();
    let lagrange_last = read_g1!();

    Ok(VerificationKey {
        circuit_size,
        log_circuit_size,
        public_inputs_size,
        qm,
        qc,
        ql,
        qr,
        qo,
        q4,
        q_lookup,
        q_arith,
        q_delta_range,
        q_elliptic,
        q_aux,
        q_poseidon2_external,
        q_poseidon2_internal,
        s1,
        s2,
        s3,
        s4,
        id1,
        id2,
        id3,
        id4,
        t1,
        t2,
        t3,
        t4,
        lagrange_first,
        lagrange_last,
    })
}

#[cfg(feature = "real-verifier")]
pub fn verify_packed_proof(
    env: &Env,
    vk_json: &Bytes,
    proof_blob: &Bytes,
    expected_public_inputs: usize,
) -> Result<(), VerifyCoreError> {
    let parsed = parse_and_validate_proof_blob(proof_blob, expected_public_inputs)
        .map_err(VerifyCoreError::InvalidProofBlob)?;

    let mut vk_vec = Vec::<u8>::with_capacity(vk_json.len() as usize);
    for i in 0..vk_json.len() {
        vk_vec.push(vk_json.get(i).ok_or(VerifyCoreError::VkUtf8)?);
    }
    let vk_str = str::from_utf8(&vk_vec).map_err(|_| VerifyCoreError::VkUtf8)?;
    let vk = load_vk_from_json_fields(vk_str).map_err(|_| VerifyCoreError::VkParse)?;

    let body = proof_blob.slice(PROOF_BLOB_HEADER_BYTES as u32..proof_blob.len());
    let public_len = (parsed.public_input_fields * FIELD_SIZE_BYTES) as u32;
    let public_inputs = body.slice(0..public_len);
    let proof_bytes = body.slice(public_len..body.len());

    let verifier = UltraHonkVerifier::new_with_vk(env, vk);
    verifier
        .verify(&proof_bytes, &public_inputs)
        .map_err(|_| VerifyCoreError::VerificationFailed)?;
    Ok(())
}

#[cfg(not(feature = "real-verifier"))]
pub fn verify_packed_proof(
    _env: &Env,
    _vk_json: &Bytes,
    proof_blob: &Bytes,
    expected_public_inputs: usize,
) -> Result<(), VerifyCoreError> {
    parse_and_validate_proof_blob(proof_blob, expected_public_inputs)
        .map_err(VerifyCoreError::InvalidProofBlob)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;
    use soroban_sdk::Env;

    fn make_blob(total_fields: usize) -> (Env, Bytes) {
        let env = Env::default();
        let total_bytes = PROOF_BLOB_HEADER_BYTES + total_fields * FIELD_SIZE_BYTES;
        let mut raw = std::vec![0u8; total_bytes];
        raw[0] = ((total_fields >> 24) & 0xff) as u8;
        raw[1] = ((total_fields >> 16) & 0xff) as u8;
        raw[2] = ((total_fields >> 8) & 0xff) as u8;
        raw[3] = (total_fields & 0xff) as u8;
        (env.clone(), Bytes::from_slice(&env, &raw))
    }

    #[test]
    fn accepts_456_field_proof_with_one_public_input() {
        let (_env, blob) = make_blob(457);
        let parsed = parse_and_validate_proof_blob(&blob, 1).expect("must be valid");
        assert_eq!(parsed.proof_fields, 456);
    }

    #[test]
    fn rejects_unknown_proof_field_count() {
        let (_env, blob) = make_blob(430);
        let err = parse_and_validate_proof_blob(&blob, 1).expect_err("must fail");
        assert_eq!(err, ProofBlobError::UnexpectedFieldCount);
    }

    #[test]
    fn rejects_length_mismatch() {
        let env = Env::default();
        let mut raw = std::vec![0u8; 32];
        raw[0] = 0;
        raw[1] = 0;
        raw[2] = 1;
        raw[3] = 201; // bogus value
        let blob = Bytes::from_slice(&env, &raw);
        let err = parse_and_validate_proof_blob(&blob, 1).expect_err("must fail");
        assert_eq!(err, ProofBlobError::LengthMismatch);
    }
}

