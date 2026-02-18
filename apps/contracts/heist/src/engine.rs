use soroban_sdk::{Bytes, BytesN, Env, Vec};

use crate::{Camera, Game, Laser, Position};

pub const MAP_W: u32 = 12;
pub const MAP_H: u32 = 12;
pub const CELL_COUNT: u32 = MAP_W * MAP_H;
pub const BITSET_BYTES: usize = 18; // 144 bits
pub const GAME_SECONDS: u64 = 300;
pub const CAMERA_PENALTY: i128 = 1;
pub const LASER_PENALTY: i128 = 2;

pub fn commit_hash(env: &Env, seed_secret: &BytesN<32>) -> BytesN<32> {
    let mut b = Bytes::new(env);
    b.append(&Bytes::from(seed_secret.clone()));
    env.crypto().keccak256(&b).into()
}

pub fn derive_session_seed(env: &Env, session_id: u32, s1: &BytesN<32>, s2: &BytesN<32>) -> BytesN<32> {
    let mut b = Bytes::new(env);
    b.append(&Bytes::from_array(env, &session_id.to_be_bytes()));
    b.append(&Bytes::from(s1.clone()));
    b.append(&Bytes::from(s2.clone()));
    env.crypto().keccak256(&b).into()
}

pub fn roll_value(env: &Env, session_seed: BytesN<32>, turn_index: u32, player_tag: u32) -> u32 {
    let mut b = Bytes::new(env);
    b.append(&Bytes::from(session_seed));
    b.append(&Bytes::from_array(env, &turn_index.to_be_bytes()));
    b.append(&Bytes::from_array(env, &player_tag.to_be_bytes()));
    let seed: BytesN<32> = env.crypto().keccak256(&b).into();
    env.prng().seed(seed.into());
    env.prng().gen_range::<u64>(1..=6) as u32
}

fn idx(x: u32, y: u32) -> u32 {
    y * MAP_W + x
}

pub fn bit_is_set(bits: &[u8; BITSET_BYTES], bit_index: u32) -> bool {
    let byte = (bit_index / 8) as usize;
    let offset = (bit_index % 8) as u8;
    (bits[byte] & (1 << offset)) != 0
}

pub fn bit_set(bits: &mut [u8; BITSET_BYTES], bit_index: u32) {
    let byte = (bit_index / 8) as usize;
    let offset = (bit_index % 8) as u8;
    bits[byte] |= 1 << offset;
}

pub fn to_arr18(bits: &BytesN<18>) -> [u8; BITSET_BYTES] {
    let mut out = [0u8; BITSET_BYTES];
    let mut i = 0u32;
    while i < BITSET_BYTES as u32 {
        out[i as usize] = bits.get(i).unwrap_or(0);
        i += 1;
    }
    out
}

pub fn from_arr18(env: &Env, bits: &[u8; BITSET_BYTES]) -> BytesN<18> {
    BytesN::from_array(env, bits)
}

pub fn zero_bitset(env: &Env) -> BytesN<18> {
    from_arr18(env, &[0u8; BITSET_BYTES])
}

pub fn has_any_set_bit(bits: &BytesN<18>) -> bool {
    let mut i = 0u32;
    while i < BITSET_BYTES as u32 {
        if bits.get(i).unwrap_or(0) != 0 {
            return true;
        }
        i += 1;
    }
    false
}

fn is_walkable(walls: &[u8; BITSET_BYTES], x: i32, y: i32) -> bool {
    if x < 0 || y < 0 || x as u32 >= MAP_W || y as u32 >= MAP_H {
        return false;
    }
    !bit_is_set(walls, idx(x as u32, y as u32))
}

pub fn exists_any_path_len(walls: &[u8; BITSET_BYTES], start: &Position, steps: u32) -> bool {
    has_any_path(walls, start.x as i32, start.y as i32, steps)
}

fn has_any_path(walls: &[u8; BITSET_BYTES], x: i32, y: i32, steps: u32) -> bool {
    if steps == 0 {
        return true;
    }
    if !is_walkable(walls, x, y) {
        return false;
    }
    has_any_path(walls, x + 1, y, steps - 1)
        || has_any_path(walls, x - 1, y, steps - 1)
        || has_any_path(walls, x, y + 1, steps - 1)
        || has_any_path(walls, x, y - 1, steps - 1)
}

/// Reveal a symmetric 5×5 area centered on (cx, cy), clamped to grid bounds.
/// Using cx±2 instead of the old cx-1 + 4 ensures both players see the same
/// number of cells regardless of their spawn corner.
pub fn reveal_fog_4x4(fog: &mut [u8; BITSET_BYTES], cx: u32, cy: u32) {
    let start_x = if cx >= 2 { cx - 2 } else { 0 };
    let start_y = if cy >= 2 { cy - 2 } else { 0 };
    // +2 end, clamped to MAP_W/H - 1
    let end_x = if cx + 2 < MAP_W { cx + 2 } else { MAP_W - 1 };
    let end_y = if cy + 2 < MAP_H { cy + 2 } else { MAP_H - 1 };

    let mut x = start_x;
    while x <= end_x {
        let mut y = start_y;
        while y <= end_y {
            bit_set(fog, idx(x, y));
            y += 1;
        }
        x += 1;
    }
}

pub fn is_full_collection(loot: &BytesN<18>, collected: &BytesN<18>) -> bool {
    let l = to_arr18(loot);
    let c = to_arr18(collected);
    let mut i = 0usize;
    while i < BITSET_BYTES {
        if (l[i] & !c[i]) != 0 {
            return false;
        }
        i += 1;
    }
    true
}

fn append_bitset_hash_bytes(env: &Env, out: &mut Bytes, b: &BytesN<18>) {
    let mut i = 0u32;
    while i < BITSET_BYTES as u32 {
        let one = [b.get(i).unwrap_or(0)];
        out.append(&Bytes::from_array(env, &one));
        i += 1;
    }
}

fn append_u32(env: &Env, out: &mut Bytes, v: u32) {
    out.append(&Bytes::from_array(env, &v.to_be_bytes()));
}

fn append_u64(env: &Env, out: &mut Bytes, v: u64) {
    out.append(&Bytes::from_array(env, &v.to_be_bytes()));
}

fn append_i128(env: &Env, out: &mut Bytes, v: i128) {
    out.append(&Bytes::from_array(env, &v.to_be_bytes()));
}

pub fn compute_state_hash(env: &Env, session_id: u32, game: &Game) -> BytesN<32> {
    let mut b = Bytes::new(env);
    append_u32(env, &mut b, session_id);
    append_u32(env, &mut b, game.turn_index);
    append_u32(env, &mut b, game.player1_pos.x);
    append_u32(env, &mut b, game.player1_pos.y);
    append_u32(env, &mut b, game.player2_pos.x);
    append_u32(env, &mut b, game.player2_pos.y);
    append_i128(env, &mut b, game.player1_score);
    append_i128(env, &mut b, game.player2_score);
    append_bitset_hash_bytes(env, &mut b, &game.walls);
    append_bitset_hash_bytes(env, &mut b, &game.loot);
    append_bitset_hash_bytes(env, &mut b, &game.loot_collected);
    append_bitset_hash_bytes(env, &mut b, &game.fog_p1);
    append_bitset_hash_bytes(env, &mut b, &game.fog_p2);
    if let Some(seed) = &game.session_seed {
        b.append(&Bytes::from(seed.clone()));
    }
    if let Some(d) = game.deadline_ts {
        append_u64(env, &mut b, d);
    }
    env.crypto().keccak256(&b).into()
}

fn seeded_u32(env: &Env, seed: &BytesN<32>, tag: u32, i: u32) -> u32 {
    let mut b = Bytes::new(env);
    b.append(&Bytes::from(seed.clone()));
    b.append(&Bytes::from_array(env, &tag.to_be_bytes()));
    b.append(&Bytes::from_array(env, &i.to_be_bytes()));
    let h: BytesN<32> = env.crypto().keccak256(&b).into();
    let mut arr = [0u8; 4];
    arr[0] = h.get(0).unwrap_or(0);
    arr[1] = h.get(1).unwrap_or(0);
    arr[2] = h.get(2).unwrap_or(0);
    arr[3] = h.get(3).unwrap_or(0);
    u32::from_be_bytes(arr)
}

fn near_spawn(x: u32, y: u32) -> bool {
    let p1x = 1u32;
    let p1y = 1u32;
    let p2x = MAP_W - 2;
    let p2y = MAP_H - 2;

    (abs_diff(x, p1x) <= 1 && abs_diff(y, p1y) <= 1)
        || (abs_diff(x, p2x) <= 1 && abs_diff(y, p2y) <= 1)
}

fn abs_diff(a: u32, b: u32) -> u32 {
    if a > b { a - b } else { b - a }
}

pub fn generate_map(env: &Env, seed: &BytesN<32>) -> (BytesN<18>, BytesN<18>, Vec<Camera>, Vec<Laser>) {
    let mut walls = [0u8; BITSET_BYTES];
    let mut loot = [0u8; BITSET_BYTES];

    // Build deterministic walls while preserving safe spawn zones.
    let mut i = 0u32;
    let mut placed_walls = 0u32;
    while i < 500 && placed_walls < 18 {
        let r = seeded_u32(env, seed, 1, i);
        let x = r % MAP_W;
        let y = (r / MAP_W) % MAP_H;
        if !near_spawn(x, y) {
            let bit = idx(x, y);
            if !bit_is_set(&walls, bit) {
                bit_set(&mut walls, bit);
                placed_walls += 1;
            }
        }
        i += 1;
    }

    // Build deterministic loot on non-wall, non-spawn-adjacent cells.
    let mut j = 0u32;
    let mut placed_loot = 0u32;
    while j < 1000 && placed_loot < 24 {
        let r = seeded_u32(env, seed, 2, j);
        let x = r % MAP_W;
        let y = (r / MAP_W) % MAP_H;
        let bit = idx(x, y);
        if !near_spawn(x, y) && !bit_is_set(&walls, bit) && !bit_is_set(&loot, bit) {
            bit_set(&mut loot, bit);
            placed_loot += 1;
        }
        j += 1;
    }

    let mut cameras = Vec::new(env);
    let mut c = 0u32;
    while c < 3 {
        let r = seeded_u32(env, seed, 3, c);
        let x = r % MAP_W;
        let y = (r / MAP_W) % MAP_H;
        if !near_spawn(x, y) {
            cameras.push_back(Camera { x, y, radius: 2 });
        }
        c += 1;
    }

    let mut lasers = Vec::new(env);
    let mut l = 0u32;
    while l < 2 {
        let r = seeded_u32(env, seed, 4, l);
        if (r & 1) == 0 {
            let y = (r / 17) % MAP_H;
            if y > 1 && y < MAP_H - 2 {
                lasers.push_back(Laser {
                    x1: 1,
                    y1: y,
                    x2: MAP_W - 2,
                    y2: y,
                });
            }
        } else {
            let x = (r / 17) % MAP_W;
            if x > 1 && x < MAP_W - 2 {
                lasers.push_back(Laser {
                    x1: x,
                    y1: 1,
                    x2: x,
                    y2: MAP_H - 2,
                });
            }
        }
        l += 1;
    }

    (
        from_arr18(env, &walls),
        from_arr18(env, &loot),
        cameras,
        lasers,
    )
}
