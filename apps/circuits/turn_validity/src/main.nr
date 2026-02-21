// HeistDuel - Turn Validity ZK Circuit
//
// Proves that a player's turn is valid without revealing:
//   - The map layout (walls, loot, cameras, lasers)
//   - The player's exact position
//   - The path taken
//   - Per-hazard hit counts
//
// PUBLIC input (single Field): pi_hash
//   = keccak256(session_id || turn_index || player_tag
//               || p1_map_seed_commit || p2_map_seed_commit || map_commitment
//               || pos_commit_before || pos_commit_after
//               || state_commit_before || state_commit_after
//               || score_delta_bytes(16) || loot_delta || no_path_flag)
//   with byte[0] zeroed to fit in BN254 field (< 2^254).

// --- Constants ---------------------------------------------------------------

global MAP_W: u32 = 12;
global MAP_H: u32 = 12;
global CAMERA_PENALTY: Field = 1;
global LASER_PENALTY: Field = 2;
global MAX_WALLS: u32 = 18;
global MAX_LOOT: u32 = 24;

// --- Keccak-256 via keccakf1600 ----------------------------------------------
//
// std::hash::keccakf1600([u64; 25]) -> [u64; 25]  (Noir 1.0.0+ builtin)
//
// Keccak-256 parameters:
//   rate r = 136 bytes, capacity c = 64 bytes
//   padding: append 0x01 at byte[len], 0x80 at byte[135]
//   output: first 32 bytes of state (little-endian u64s)

fn load_u64_le(block: [u8; 136], lane: u32) -> u64 {
    let b = lane * 8;
    (block[b] as u64)
        | ((block[b + 1] as u64) << 8)
        | ((block[b + 2] as u64) << 16)
        | ((block[b + 3] as u64) << 24)
        | ((block[b + 4] as u64) << 32)
        | ((block[b + 5] as u64) << 40)
        | ((block[b + 6] as u64) << 48)
        | ((block[b + 7] as u64) << 56)
}

fn squeeze32(state: [u64; 25]) -> [u8; 32] {
    let mut out: [u8; 32] = [0; 32];
    for i in 0..4 {
        let v = state[i];
        let b = i * 8;
        out[b]     = (v & 0xFF) as u8;
        out[b + 1] = ((v >> 8)  & 0xFF) as u8;
        out[b + 2] = ((v >> 16) & 0xFF) as u8;
        out[b + 3] = ((v >> 24) & 0xFF) as u8;
        out[b + 4] = ((v >> 32) & 0xFF) as u8;
        out[b + 5] = ((v >> 40) & 0xFF) as u8;
        out[b + 6] = ((v >> 48) & 0xFF) as u8;
        out[b + 7] = ((v >> 56) & 0xFF) as u8;
    }
    out
}

// Absorb one 136-byte block into the keccak state.
fn absorb_block(state: [u64; 25], block: [u8; 136]) -> [u64; 25] {
    let mut s = state;
    for i in 0..17 {
        s[i] = s[i] ^ load_u64_le(block, i as u32);
    }
    std::hash::keccakf1600(s)
}

// Keccak-256 of a 32-byte input.
fn keccak256_32(input: [u8; 32]) -> [u8; 32] {
    let mut block: [u8; 136] = [0; 136];
    for i in 0..32 { block[i] = input[i]; }
    block[32]  = 0x01;
    block[135] = 0x80;
    squeeze32(absorb_block([0; 25], block))
}

// Keccak-256 of a 36-byte input.
fn keccak256_36(input: [u8; 36]) -> [u8; 32] {
    let mut block: [u8; 136] = [0; 136];
    for i in 0..36 { block[i] = input[i]; }
    block[36]  = 0x01;
    block[135] = 0x80;
    squeeze32(absorb_block([0; 25], block))
}

// Keccak-256 of a 40-byte input.
fn keccak256_40(input: [u8; 40]) -> [u8; 32] {
    let mut block: [u8; 136] = [0; 136];
    for i in 0..40 { block[i] = input[i]; }
    block[40]  = 0x01;
    block[135] = 0x80;
    squeeze32(absorb_block([0; 25], block))
}

// Keccak-256 of a 106-byte input.
fn keccak256_106(input: [u8; 106]) -> [u8; 32] {
    let mut block: [u8; 136] = [0; 136];
    for i in 0..106 { block[i] = input[i]; }
    block[106] = 0x01;
    block[135] = 0x80;
    squeeze32(absorb_block([0; 25], block))
}

// Keccak-256 of a 176-byte input (two blocks: 136 + 40).
// Used for state commitment: 4+4+16+16+32+32+32+32+8 = 176 bytes.
fn keccak256_176(input: [u8; 176]) -> [u8; 32] {
    // Block 1: bytes 0..136 (full rate block)
    let mut block1: [u8; 136] = [0; 136];
    for i in 0..136 { block1[i] = input[i]; }
    let s1 = absorb_block([0; 25], block1);

    // Block 2: bytes 136..176 (40 bytes of data) + padding
    let mut block2: [u8; 136] = [0; 136];
    for i in 0..40 { block2[i] = input[136 + i]; }
    block2[40]  = 0x01;
    block2[135] = 0x80;
    squeeze32(absorb_block(s1, block2))
}

// Keccak-256 of a 257-byte input (two blocks: 136 + 121).
fn keccak256_257(input: [u8; 257]) -> [u8; 32] {
    // Block 1: bytes 0..136
    let mut block1: [u8; 136] = [0; 136];
    for i in 0..136 { block1[i] = input[i]; }
    let s1 = absorb_block([0; 25], block1);

    // Block 2: bytes 136..257 (121 bytes of data) + padding
    let mut block2: [u8; 136] = [0; 136];
    for i in 0..121 { block2[i] = input[136 + i]; }
    block2[121] = 0x01;
    block2[135] = 0x80;
    squeeze32(absorb_block(s1, block2))
}

// --- Signed integer helpers --------------------------------------------------

// Reconstruct a signed Field value from a 16-byte big-endian i128 (two's complement).
// Supports the full i128 range by handling the sign bit correctly in BN254 Field.
fn field_from_i128_bytes(bytes: [u8; 16]) -> Field {
    // Interpret bytes as unsigned big-endian integer.
    let mut raw: Field = 0;
    for i in 0..16 {
        raw = raw * 256 + (bytes[i] as Field);
    }
    // If the high bit of bytes[0] is set, the value is negative in two's complement.
    // Negative: actual_value = raw - 2^128  (in Field arithmetic this wraps correctly).
    let is_neg = (bytes[0] as u32 >= 128);
    // 2^128 = 340282366920938463463374607431768211456
    let two_pow_128: Field = 340282366920938463463374607431768211456;
    if is_neg { raw - two_pow_128 } else { raw }
}

// --- Bitset helpers ----------------------------------------------------------

fn bit_is_set(bits: [u8; 18], bit_index: u32) -> bool {
    let byte_idx: u32 = bit_index / 8;
    let offset: u8    = (bit_index % 8) as u8;
    (bits[byte_idx] & ((1 as u8) << offset)) != 0
}

fn bit_set(bits: &mut [u8; 18], bit_index: u32) {
    let byte_idx: u32 = bit_index / 8;
    let offset: u8    = (bit_index % 8) as u8;
    bits[byte_idx] = bits[byte_idx] | ((1 as u8) << offset);
}

fn idx(x: u32, y: u32) -> u32 {
    y * MAP_W + x
}

// --- Field conversion --------------------------------------------------------

fn bytes32_to_field_skip_first(bytes: [u8; 32]) -> Field {
    // Treat bytes[1..32] as a 31-byte big-endian integer.
    let mut acc: Field = 0;
    for i in 1..32 {
        acc = acc * 256 + (bytes[i] as Field);
    }
    acc
}

fn xor32(a: [u8; 32], b: [u8; 32]) -> [u8; 32] {
    let mut out: [u8; 32] = [0; 32];
    for i in 0..32 { out[i] = a[i] ^ b[i]; }
    out
}

// --- Seeded u32 --------------------------------------------------------------

fn seeded_u32(seed: [u8; 32], tag: u32, i: u32) -> u32 {
    let mut input: [u8; 40] = [0; 40];
    for k in 0..32 { input[k] = seed[k]; }
    input[32] = ((tag >> 24) & 0xFF) as u8;
    input[33] = ((tag >> 16) & 0xFF) as u8;
    input[34] = ((tag >>  8) & 0xFF) as u8;
    input[35] = (tag & 0xFF) as u8;
    input[36] = ((i >> 24) & 0xFF) as u8;
    input[37] = ((i >> 16) & 0xFF) as u8;
    input[38] = ((i >>  8) & 0xFF) as u8;
    input[39] = (i & 0xFF) as u8;
    let h = keccak256_40(input);
    ((h[0] as u32) << 24) | ((h[1] as u32) << 16) | ((h[2] as u32) << 8) | (h[3] as u32)
}

fn near_spawn(x: u32, y: u32) -> bool {
    let p2x: u32 = MAP_W - 2;
    let p2y: u32 = MAP_H - 2;
    let near_p1 = {
        let dx = if x >= 1 { x - 1 } else { 1 - x };
        let dy = if y >= 1 { y - 1 } else { 1 - y };
        (dx <= 1) & (dy <= 1)
    };
    let near_p2 = {
        let dx = if x >= p2x { x - p2x } else { p2x - x };
        let dy = if y >= p2y { y - p2y } else { p2y - y };
        (dx <= 1) & (dy <= 1)
    };
    near_p1 | near_p2
}

// --- Map generation (mirrors Rust engine.rs + TypeScript engine.ts) ----------
// Iteration bounds (80 walls, 160 loot) must match both implementations.

struct Camera { x: u32, y: u32, radius: u32 }
struct Laser  { x1: u32, y1: u32, x2: u32, y2: u32 }

fn generate_map(seed: [u8; 32]) -> ([u8; 18], [u8; 18], [Camera; 3], u32, [Laser; 2], u32) {
    let mut walls: [u8; 18] = [0; 18];
    let mut loot:  [u8; 18] = [0; 18];

    let mut placed_walls: u32 = 0;
    for i in 0..80 {
        if placed_walls < MAX_WALLS {
            let r = seeded_u32(seed, 1, i as u32);
            let x = r % MAP_W;
            let y = (r / MAP_W) % MAP_H;
            if !near_spawn(x, y) {
                let bit = idx(x, y);
                if !bit_is_set(walls, bit) {
                    bit_set(&mut walls, bit);
                    placed_walls += 1;
                }
            }
        }
    }

    let mut placed_loot: u32 = 0;
    for j in 0..160 {
        if placed_loot < MAX_LOOT {
            let r = seeded_u32(seed, 2, j as u32);
            let x = r % MAP_W;
            let y = (r / MAP_W) % MAP_H;
            let bit = idx(x, y);
            if !near_spawn(x, y) & !bit_is_set(walls, bit) & !bit_is_set(loot, bit) {
                bit_set(&mut loot, bit);
                placed_loot += 1;
            }
        }
    }

    let mut cameras: [Camera; 3] = [Camera { x: 0, y: 0, radius: 0 }; 3];
    let mut num_cameras: u32 = 0;
    for c in 0..3 {
        let r = seeded_u32(seed, 3, c as u32);
        let x = r % MAP_W;
        let y = (r / MAP_W) % MAP_H;
        if !near_spawn(x, y) {
            cameras[num_cameras] = Camera { x, y, radius: 2 };
            num_cameras += 1;
        }
    }

    let mut lasers: [Laser; 2] = [Laser { x1: 0, y1: 0, x2: 0, y2: 0 }; 2];
    let mut num_lasers: u32 = 0;
    for l in 0..2 {
        let r = seeded_u32(seed, 4, l as u32);
        if (r & 1) == 0 {
            let y = (r / 17) % MAP_H;
            if (y > 1) & (y < MAP_H - 2) {
                lasers[num_lasers] = Laser { x1: 1, y1: y, x2: MAP_W - 2, y2: y };
                num_lasers += 1;
            }
        } else {
            let x = (r / 17) % MAP_W;
            if (x > 1) & (x < MAP_W - 2) {
                lasers[num_lasers] = Laser { x1: x, y1: 1, x2: x, y2: MAP_H - 2 };
                num_lasers += 1;
            }
        }
    }

    (walls, loot, cameras, num_cameras, lasers, num_lasers)
}

// --- Map commitment (mirrors serializeMapData + keccak in engine.ts) ---------

fn compute_map_commitment(
    walls: [u8; 18], loot: [u8; 18],
    cameras: [Camera; 3], num_cameras: u32,
    lasers:  [Laser; 2],  num_lasers:  u32,
) -> [u8; 32] {
    // 18 + 18 + 1 + 3*12 + 1 + 2*16 = 106 bytes
    let mut buf: [u8; 106] = [0; 106];
    let mut off: u32 = 0;

    for i in 0..18 { buf[off] = walls[i]; off += 1; }
    for i in 0..18 { buf[off] = loot[i];  off += 1; }

    buf[off] = num_cameras as u8; off += 1;
    for c in 0..3 {
        let cam = cameras[c];
        let include = (c as u32) < num_cameras;
        let cx = if include { cam.x } else { 0 };
        let cy = if include { cam.y } else { 0 };
        let cr = if include { cam.radius } else { 0 };
        buf[off]      = ((cx >> 24) & 0xFF) as u8; buf[off + 1]  = ((cx >> 16) & 0xFF) as u8;
        buf[off + 2]  = ((cx >>  8) & 0xFF) as u8; buf[off + 3]  = (cx & 0xFF) as u8;
        buf[off + 4]  = ((cy >> 24) & 0xFF) as u8; buf[off + 5]  = ((cy >> 16) & 0xFF) as u8;
        buf[off + 6]  = ((cy >>  8) & 0xFF) as u8; buf[off + 7]  = (cy & 0xFF) as u8;
        buf[off + 8]  = ((cr >> 24) & 0xFF) as u8; buf[off + 9]  = ((cr >> 16) & 0xFF) as u8;
        buf[off + 10] = ((cr >>  8) & 0xFF) as u8; buf[off + 11] = (cr & 0xFF) as u8;
        off += 12;
    }

    buf[off] = num_lasers as u8; off += 1;
    for l in 0..2 {
        let laser = lasers[l];
        let include = (l as u32) < num_lasers;
        let lx1 = if include { laser.x1 } else { 0 };
        let ly1 = if include { laser.y1 } else { 0 };
        let lx2 = if include { laser.x2 } else { 0 };
        let ly2 = if include { laser.y2 } else { 0 };
        buf[off]      = ((lx1 >> 24) & 0xFF) as u8; buf[off + 1]  = ((lx1 >> 16) & 0xFF) as u8;
        buf[off + 2]  = ((lx1 >>  8) & 0xFF) as u8; buf[off + 3]  = (lx1 & 0xFF) as u8;
        buf[off + 4]  = ((ly1 >> 24) & 0xFF) as u8; buf[off + 5]  = ((ly1 >> 16) & 0xFF) as u8;
        buf[off + 6]  = ((ly1 >>  8) & 0xFF) as u8; buf[off + 7]  = (ly1 & 0xFF) as u8;
        buf[off + 8]  = ((lx2 >> 24) & 0xFF) as u8; buf[off + 9]  = ((lx2 >> 16) & 0xFF) as u8;
        buf[off + 10] = ((lx2 >>  8) & 0xFF) as u8; buf[off + 11] = (lx2 & 0xFF) as u8;
        buf[off + 12] = ((ly2 >> 24) & 0xFF) as u8; buf[off + 13] = ((ly2 >> 16) & 0xFF) as u8;
        buf[off + 14] = ((ly2 >>  8) & 0xFF) as u8; buf[off + 15] = (ly2 & 0xFF) as u8;
        off += 16;
    }

    keccak256_106(buf)
}

// --- State commitment (mirrors compute_state_commitment in engine.rs) --------
//
// Preimage layout (176 bytes):
//   session_id(4) || turn_index(4) || p1_score(16) || p2_score(16)
//   || map_commitment(32) || p1_pos(32) || p2_pos(32)
//   || session_seed(32) || deadline_ts(8)

fn compute_state_commitment(
    session_id:   u32,
    turn_idx:     u32,
    p1_score:     [u8; 16],
    p2_score:     [u8; 16],
    map_commit:   [u8; 32],
    p1_pos:       [u8; 32],
    p2_pos:       [u8; 32],
    session_seed: [u8; 32],
    deadline_ts:  [u8; 8],
) -> [u8; 32] {
    let mut buf: [u8; 176] = [0; 176];
    let mut off: u32 = 0;

    buf[off] = ((session_id >> 24) & 0xFF) as u8; off += 1;
    buf[off] = ((session_id >> 16) & 0xFF) as u8; off += 1;
    buf[off] = ((session_id >>  8) & 0xFF) as u8; off += 1;
    buf[off] = (session_id & 0xFF) as u8;         off += 1;

    buf[off] = ((turn_idx >> 24) & 0xFF) as u8; off += 1;
    buf[off] = ((turn_idx >> 16) & 0xFF) as u8; off += 1;
    buf[off] = ((turn_idx >>  8) & 0xFF) as u8; off += 1;
    buf[off] = (turn_idx & 0xFF) as u8;         off += 1;

    for i in 0..16 { buf[off] = p1_score[i];    off += 1; }
    for i in 0..16 { buf[off] = p2_score[i];    off += 1; }
    for i in 0..32 { buf[off] = map_commit[i];  off += 1; }
    for i in 0..32 { buf[off] = p1_pos[i];      off += 1; }
    for i in 0..32 { buf[off] = p2_pos[i];      off += 1; }
    for i in 0..32 { buf[off] = session_seed[i]; off += 1; }
    for i in 0..8  { buf[off] = deadline_ts[i]; off += 1; }

    keccak256_176(buf)
}

// --- Position commitment -----------------------------------------------------

fn compute_pos_commit(x: u32, y: u32, nonce: [u8; 32]) -> [u8; 32] {
    let mut buf: [u8; 40] = [0; 40];
    buf[0] = ((x >> 24) & 0xFF) as u8;
    buf[1] = ((x >> 16) & 0xFF) as u8;
    buf[2] = ((x >>  8) & 0xFF) as u8;
    buf[3] = (x & 0xFF) as u8;
    buf[4] = ((y >> 24) & 0xFF) as u8;
    buf[5] = ((y >> 16) & 0xFF) as u8;
    buf[6] = ((y >>  8) & 0xFF) as u8;
    buf[7] = (y & 0xFF) as u8;
    for i in 0..32 { buf[8 + i] = nonce[i]; }
    keccak256_40(buf)
}

// --- Dice PRNG ---------------------------------------------------------------

fn roll_value(session_seed: [u8; 32], turn_index: u32, player_tag: u32) -> u32 {
    let mut buf: [u8; 40] = [0; 40];
    for i in 0..32 { buf[i] = session_seed[i]; }
    buf[32] = ((turn_index >> 24) & 0xFF) as u8;
    buf[33] = ((turn_index >> 16) & 0xFF) as u8;
    buf[34] = ((turn_index >>  8) & 0xFF) as u8;
    buf[35] = (turn_index & 0xFF) as u8;
    buf[36] = ((player_tag >> 24) & 0xFF) as u8;
    buf[37] = ((player_tag >> 16) & 0xFF) as u8;
    buf[38] = ((player_tag >>  8) & 0xFF) as u8;
    buf[39] = (player_tag & 0xFF) as u8;
    let h = keccak256_40(buf);
    (h[0] as u32) % 6 + 1
}

// --- Hazard checks -----------------------------------------------------------

fn path_hits_camera(
    path_x: [u32; 7], path_y: [u32; 7], path_len_with_start: u32, cam: Camera,
) -> bool {
    let mut hit = false;
    for i in 0..7 {
        if (i as u32) < path_len_with_start {
            let dx = if path_x[i] >= cam.x { path_x[i] - cam.x } else { cam.x - path_x[i] };
            let dy = if path_y[i] >= cam.y { path_y[i] - cam.y } else { cam.y - path_y[i] };
            if (dx + dy) <= cam.radius { hit = true; }
        }
    }
    hit
}

fn path_hits_laser(
    path_x: [u32; 7], path_y: [u32; 7], path_len_with_start: u32, laser: Laser,
) -> bool {
    let mut hit = false;
    for i in 0..7 {
        if (i as u32) < path_len_with_start {
            let px = path_x[i];
            let py = path_y[i];
            if laser.x1 == laser.x2 {
                if (px == laser.x1) & (py >= laser.y1) & (py <= laser.y2) { hit = true; }
            } else {
                if (py == laser.y1) & (px >= laser.x1) & (px <= laser.x2) { hit = true; }
            }
        }
    }
    hit
}

// --- Public-input hash -------------------------------------------------------
//
// 4+4+4 + 32*7 + 16+4+1 = 12 + 224 + 21 = 257 bytes

fn compute_pi_hash(
    session_id:         u32,
    turn_index:         u32,
    player_tag:         u32,
    p1_map_seed_commit: [u8; 32],
    p2_map_seed_commit: [u8; 32],
    map_commitment:     [u8; 32],
    pos_commit_before:  [u8; 32],
    pos_commit_after:   [u8; 32],
    state_commit_before:[u8; 32],
    state_commit_after: [u8; 32],
    score_delta_bytes:  [u8; 16],
    loot_delta:         u32,
    no_path_flag:       u32,
) -> Field {
    let mut buf: [u8; 257] = [0; 257];
    let mut off: u32 = 0;
    buf[off]     = ((session_id >> 24) & 0xFF) as u8; buf[off + 1] = ((session_id >> 16) & 0xFF) as u8;
    buf[off + 2] = ((session_id >>  8) & 0xFF) as u8; buf[off + 3] = (session_id & 0xFF) as u8; off += 4;
    buf[off]     = ((turn_index >> 24) & 0xFF) as u8; buf[off + 1] = ((turn_index >> 16) & 0xFF) as u8;
    buf[off + 2] = ((turn_index >>  8) & 0xFF) as u8; buf[off + 3] = (turn_index & 0xFF) as u8; off += 4;
    buf[off]     = ((player_tag >> 24) & 0xFF) as u8; buf[off + 1] = ((player_tag >> 16) & 0xFF) as u8;
    buf[off + 2] = ((player_tag >>  8) & 0xFF) as u8; buf[off + 3] = (player_tag & 0xFF) as u8; off += 4;
    for i in 0..32 { buf[off] = p1_map_seed_commit[i]; off += 1; }
    for i in 0..32 { buf[off] = p2_map_seed_commit[i]; off += 1; }
    for i in 0..32 { buf[off] = map_commitment[i];     off += 1; }
    for i in 0..32 { buf[off] = pos_commit_before[i];  off += 1; }
    for i in 0..32 { buf[off] = pos_commit_after[i];   off += 1; }
    for i in 0..32 { buf[off] = state_commit_before[i]; off += 1; }
    for i in 0..32 { buf[off] = state_commit_after[i]; off += 1; }
    for i in 0..16 { buf[off] = score_delta_bytes[i];  off += 1; }
    buf[off]     = ((loot_delta >> 24) & 0xFF) as u8; buf[off + 1] = ((loot_delta >> 16) & 0xFF) as u8;
    buf[off + 2] = ((loot_delta >>  8) & 0xFF) as u8; buf[off + 3] = (loot_delta & 0xFF) as u8; off += 4;
    buf[off] = no_path_flag as u8;
    let mut raw = keccak256_257(buf);
    raw[0] = 0; // zero MSB for BN254 field safety
    bytes32_to_field_skip_first(raw)
}

// --- Main circuit ------------------------------------------------------------

fn main(
    // --- Private: map secrets (from backend relay) ---------------------------
    map_secret_1: [u8; 32],
    map_secret_2: [u8; 32],

    // --- Private: current position + nonce ----------------------------------
    pos_x: u32,
    pos_y: u32,
    pos_nonce: [u8; 32],

    // --- Private: path -------------------------------------------------------
    // path_x[0]/path_y[0] = start, path_x[path_len]/path_y[path_len] = end.
    path_x: [u32; 7],
    path_y: [u32; 7],
    path_len: u32,

    // --- Private: dice context -----------------------------------------------
    session_seed: [u8; 32],

    // --- Private: new position nonce -----------------------------------------
    // new_pos_nonce = keccak256(pos_nonce || turn_index_BE)
    new_pos_nonce: [u8; 32],

    // --- Private: current game state (for state commitment verification) -----
    // Current scores (i128 big-endian two's complement) before this turn.
    player1_score_bytes: [u8; 16],
    player2_score_bytes: [u8; 16],
    // New score for the active player after this turn (i128 BE two's complement).
    // Must satisfy: new_score == old_active_score + score_delta.
    new_active_score_bytes: [u8; 16],
    // Opponent's current position commitment (not the active player's).
    other_pos_commit: [u8; 32],
    // Deadline timestamp (u64 big-endian), from game.deadline_ts.
    deadline_ts_bytes: [u8; 8],

    // --- Claimed public turn data (all committed via pi_hash) ----------------
    session_id:         u32,
    turn_index:         u32,
    player_tag:         u32,           // 1 = player1, 2 = player2
    p1_map_seed_commit: [u8; 32],
    p2_map_seed_commit: [u8; 32],
    map_commitment:     [u8; 32],
    pos_commit_before:  [u8; 32],
    pos_commit_after:   [u8; 32],
    state_commit_before:[u8; 32],
    state_commit_after: [u8; 32],
    // score_delta as 16-byte big-endian i128 (single source of truth for pi_hash binding).
    score_delta_bytes:  [u8; 16],
    loot_delta:         u32,
    no_path_flag:       u32,           // 0 or 1

    // --- Single public input -------------------------------------------------
    pi_hash: pub Field,
) {
    // -------------------------------------------------------------------------
    // Step 1: Bind pi_hash to all claimed public data.
    // -------------------------------------------------------------------------
    let computed_pi = compute_pi_hash(
        session_id, turn_index, player_tag,
        p1_map_seed_commit, p2_map_seed_commit, map_commitment,
        pos_commit_before, pos_commit_after,
        state_commit_before, state_commit_after,
        score_delta_bytes, loot_delta, no_path_flag,
    );
    assert(pi_hash == computed_pi, "pi_hash mismatch");

    // -------------------------------------------------------------------------
    // Step 2: Verify map secret commitments.
    // -------------------------------------------------------------------------
    let p1_commit = keccak256_32(map_secret_1);
    assert(p1_commit == p1_map_seed_commit, "p1 map seed commit mismatch");
    let p2_commit = keccak256_32(map_secret_2);
    assert(p2_commit == p2_map_seed_commit, "p2 map seed commit mismatch");

    // -------------------------------------------------------------------------
    // Step 3: Derive map_seed = keccak(secret1 XOR secret2).
    // -------------------------------------------------------------------------
    let xored   = xor32(map_secret_1, map_secret_2);
    let map_seed = keccak256_32(xored);

    // -------------------------------------------------------------------------
    // Step 4: Generate map from seed.
    // -------------------------------------------------------------------------
    let (walls, loot, cameras, num_cameras, lasers, num_lasers) = generate_map(map_seed);

    // -------------------------------------------------------------------------
    // Step 5: Verify map commitment.
    // -------------------------------------------------------------------------
    let map_commit_computed = compute_map_commitment(walls, loot, cameras, num_cameras, lasers, num_lasers);
    assert(map_commit_computed == map_commitment, "map commitment mismatch");

    // -------------------------------------------------------------------------
    // Step 6: Verify position commitment before.
    // -------------------------------------------------------------------------
    let pos_before_computed = compute_pos_commit(pos_x, pos_y, pos_nonce);
    assert(pos_before_computed == pos_commit_before, "pos_commit_before mismatch");

    // -------------------------------------------------------------------------
    // Step 7: Verify dice roll - path length must not exceed the rolled value.
    // -------------------------------------------------------------------------
    let rolled = roll_value(session_seed, turn_index, player_tag);
    assert(path_len <= rolled, "path_len exceeds rolled value");
    if no_path_flag == 1 {
        assert(path_len == 0, "no_path_flag=1 but path_len != 0");
    }

    // -------------------------------------------------------------------------
    // Step 8: Verify path starts at the committed position.
    // -------------------------------------------------------------------------
    assert(path_x[0] == pos_x, "path start x mismatch");
    assert(path_y[0] == pos_y, "path start y mismatch");

    // -------------------------------------------------------------------------
    // Step 9: Validate each step (adjacent, in-bounds, no wall).
    // -------------------------------------------------------------------------
    for step in 0..6 {
        if (step as u32) < path_len {
            let fx = path_x[step];
            let fy = path_y[step];
            let tx = path_x[step + 1];
            let ty = path_y[step + 1];
            let dx = if tx >= fx { tx - fx } else { fx - tx };
            let dy = if ty >= fy { ty - fy } else { fy - ty };
            assert((dx + dy) == 1, "non-adjacent step");
            assert(tx < MAP_W, "step out of x bounds");
            assert(ty < MAP_H, "step out of y bounds");
            assert(!bit_is_set(walls, idx(tx, ty)), "step into wall");
        }
    }

    // -------------------------------------------------------------------------
    // Step 10: Compute end position.
    // -------------------------------------------------------------------------
    let mut end_x: u32 = pos_x;
    let mut end_y: u32 = pos_y;
    for i in 0..7 {
        if (i as u32) == path_len {
            end_x = path_x[i];
            end_y = path_y[i];
        }
    }

    // -------------------------------------------------------------------------
    // Step 11: Compute loot collected along the path.
    // -------------------------------------------------------------------------
    let mut computed_loot: u32 = 0;
    let mut loot_seen: [u8; 18] = [0; 18];
    for i in 0..7 {
        if (i as u32) <= path_len {
            let bit = idx(path_x[i], path_y[i]);
            if bit_is_set(loot, bit) & !bit_is_set(loot_seen, bit) {
                computed_loot += 1;
                bit_set(&mut loot_seen, bit);
            }
        }
    }
    assert(computed_loot == loot_delta, "loot_delta mismatch");

    // -------------------------------------------------------------------------
    // Step 12: Compute hazard hits.
    // -------------------------------------------------------------------------
    let path_len_with_start = path_len + 1;
    let mut cam_hits: u32 = 0;
    for c in 0..3 {
        if (c as u32) < num_cameras {
            if path_hits_camera(path_x, path_y, path_len_with_start, cameras[c]) {
                cam_hits += 1;
            }
        }
    }
    let mut las_hits: u32 = 0;
    for l in 0..2 {
        if (l as u32) < num_lasers {
            if path_hits_laser(path_x, path_y, path_len_with_start, lasers[l]) {
                las_hits += 1;
            }
        }
    }

    // -------------------------------------------------------------------------
    // Step 13: [FIX 1] Derive score_delta from score_delta_bytes and verify
    //          it equals the arithmetic result from loot and hazards.
    //
    //   Previously score_delta was an unbound Field input - a prover could
    //   submit score_delta_bytes = 100 in pi_hash but score_delta = 5 in the
    //   arithmetic check, gaining 100 points instead of 5.
    //
    //   Now: score_delta is reconstructed from its byte encoding (which is
    //   bound to pi_hash via step 1), then checked against the arithmetic.
    // -------------------------------------------------------------------------
    let score_delta = field_from_i128_bytes(score_delta_bytes);
    let expected_score: Field = (loot_delta as Field)
        - (cam_hits as Field) * CAMERA_PENALTY
        - (las_hits as Field) * LASER_PENALTY;
    assert(score_delta == expected_score, "score_delta mismatch");

    // -------------------------------------------------------------------------
    // Step 14: Derive new_pos_nonce = keccak256(pos_nonce || turn_index_BE).
    // -------------------------------------------------------------------------
    let mut nonce_buf: [u8; 36] = [0; 36];
    for i in 0..32 { nonce_buf[i] = pos_nonce[i]; }
    nonce_buf[32] = ((turn_index >> 24) & 0xFF) as u8;
    nonce_buf[33] = ((turn_index >> 16) & 0xFF) as u8;
    nonce_buf[34] = ((turn_index >>  8) & 0xFF) as u8;
    nonce_buf[35] = (turn_index & 0xFF) as u8;
    let derived_new_nonce = keccak256_36(nonce_buf);
    assert(derived_new_nonce == new_pos_nonce, "new_pos_nonce derivation mismatch");

    // -------------------------------------------------------------------------
    // Step 15: Verify position commitment after.
    // -------------------------------------------------------------------------
    let pos_after_computed = compute_pos_commit(end_x, end_y, new_pos_nonce);
    assert(pos_after_computed == pos_commit_after, "pos_commit_after mismatch");

    // -------------------------------------------------------------------------
    // Step 16: [FIX 2] Verify state_commit_before and state_commit_after
    //          by re-deriving both from first principles inside the circuit.
    //
    //   Previously these were only bound via pi_hash - a prover could commit
    //   to an arbitrary state_commit_after, potentially injecting a fabricated
    //   state chain while keeping scores and positions correct.
    //
    //   Now: the circuit independently computes both commitments from the
    //   private game state inputs and asserts equality. Combined with the
    //   on-chain check (state_commit_before == game.state_commitment), this
    //   closes the attack surface completely.
    // -------------------------------------------------------------------------
    let active_is_p1 = player_tag == 1;

    // Resolve current positions for each player.
    let p1_pos_cur: [u8; 32] = if active_is_p1 { pos_commit_before } else { other_pos_commit };
    let p2_pos_cur: [u8; 32] = if active_is_p1 { other_pos_commit  } else { pos_commit_before };

    // Re-derive state_commit_before and assert it matches the claimed value.
    let computed_state_before = compute_state_commitment(
        session_id, turn_index,
        player1_score_bytes, player2_score_bytes,
        map_commitment, p1_pos_cur, p2_pos_cur,
        session_seed, deadline_ts_bytes,
    );
    assert(computed_state_before == state_commit_before, "state_commit_before mismatch");

    // Verify the new score bytes are consistent with old score + score_delta.
    let old_active_score = if active_is_p1 {
        field_from_i128_bytes(player1_score_bytes)
    } else {
        field_from_i128_bytes(player2_score_bytes)
    };
    let new_active_score_field = field_from_i128_bytes(new_active_score_bytes);
    assert(new_active_score_field == old_active_score + score_delta, "new score bytes inconsistency");

    // Determine each player's updated score and position bytes.
    let new_p1_score: [u8; 16] = if active_is_p1 { new_active_score_bytes } else { player1_score_bytes };
    let new_p2_score: [u8; 16] = if active_is_p1 { player2_score_bytes    } else { new_active_score_bytes };
    let new_p1_pos:   [u8; 32] = if active_is_p1 { pos_commit_after       } else { other_pos_commit };
    let new_p2_pos:   [u8; 32] = if active_is_p1 { other_pos_commit       } else { pos_commit_after };

    // Re-derive state_commit_after and assert it matches the claimed value.
    let computed_state_after = compute_state_commitment(
        session_id, turn_index + 1,
        new_p1_score, new_p2_score,
        map_commitment, new_p1_pos, new_p2_pos,
        session_seed, deadline_ts_bytes,
    );
    assert(computed_state_after == state_commit_after, "state_commit_after mismatch");
}
