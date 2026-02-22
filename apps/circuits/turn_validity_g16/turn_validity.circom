pragma circom 2.1.6;

// HeistDuel — Turn Validity Circuit (Groth16 / BN254 / Poseidon)
//
// PUBLIC output: pi_hash = Poseidon2(
//   Poseidon4(session_id, turn_index, player_tag, pos_commit_before),
//   Poseidon4(pos_commit_after, score_delta, loot_delta, no_path_flag)
// )
// where pos_commit = Poseidon3(x, y, nonce)  — matches soroban-poseidon on-chain.

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/bitify.circom";
include "node_modules/circomlib/circuits/comparators.circom";

// ── Helper: check whether bit[bit_index] is set in an 18-byte bitset ──────────
// Outputs 1 if set, 0 otherwise.  bit_index ∈ [0, 143].

template BitIsSet() {
    signal input bitset[18];
    signal input bit_index;
    signal output out;

    // Decompose each byte into 8 bits.
    component byte_bits[18];
    for (var b = 0; b < 18; b++) {
        byte_bits[b] = Num2Bits(8);
        byte_bits[b].in <== bitset[b];
    }

    // For each of the 144 possible bit positions, check equality and accumulate.
    component eq[144];
    signal term[144];
    signal acc[145];
    acc[0] <== 0;
    for (var b = 0; b < 18; b++) {
        for (var k = 0; k < 8; k++) {
            var gi = b * 8 + k;
            eq[gi] = IsEqual();
            eq[gi].in[0] <== bit_index;
            eq[gi].in[1] <== gi;
            term[gi] <== eq[gi].out * byte_bits[b].out[k];
            acc[gi + 1] <== acc[gi] + term[gi];
        }
    }
    out <== acc[144];
}

// ── Helper: adjacency check (Manhattan distance == 1) ─────────────────────────

template IsAdjacent() {
    signal input x0; signal input y0;
    signal input x1; signal input y1;
    signal output valid;

    component dx_pos = IsEqual(); dx_pos.in[0] <== x1 - x0; dx_pos.in[1] <== 1;
    component dx_neg = IsEqual(); dx_neg.in[0] <== x0 - x1; dx_neg.in[1] <== 1;
    component dy_pos = IsEqual(); dy_pos.in[0] <== y1 - y0; dy_pos.in[1] <== 1;
    component dy_neg = IsEqual(); dy_neg.in[0] <== y0 - y1; dy_neg.in[1] <== 1;
    component x_eq   = IsEqual(); x_eq.in[0]   <== x0;      x_eq.in[1]   <== x1;
    component y_eq   = IsEqual(); y_eq.in[0]   <== y0;      y_eq.in[1]   <== y1;

    signal dx_one <== dx_pos.out + dx_neg.out;
    signal dy_one <== dy_pos.out + dy_neg.out;
    signal case_x <== dx_one * y_eq.out;
    signal case_y <== dy_one * x_eq.out;
    valid <== case_x + case_y - case_x * case_y;
}

// ── Helper: in-bounds check (x ∈ [0,11], y ∈ [0,11]) ─────────────────────────

template InBounds12() {
    signal input x;
    signal input y;
    signal output valid;

    component x_lt = LessThan(8); x_lt.in[0] <== x; x_lt.in[1] <== 12;
    component y_lt = LessThan(8); y_lt.in[0] <== y; y_lt.in[1] <== 12;
    valid <== x_lt.out * y_lt.out;
}

// ── Main circuit ──────────────────────────────────────────────────────────────

template TurnValidity() {

    // ── Private inputs ─────────────────────────────────────────────────────────
    signal input map_walls[18];
    signal input map_loot[18];

    signal input pos_x;
    signal input pos_y;
    signal input pos_nonce;       // BN254 Fr element (32-byte nonce, first byte 0)

    signal input path_x[7];
    signal input path_y[7];
    signal input path_len;        // ∈ [0, 6]

    signal input new_pos_nonce;

    // ── Public turn data ───────────────────────────────────────────────────────
    signal input session_id;
    signal input turn_index;
    signal input player_tag;
    signal input score_delta;     // BN254 Fr (negative → prime + value)
    signal input loot_delta;
    signal input no_path_flag;    // 0 or 1

    // ── Public output ──────────────────────────────────────────────────────────
    signal output pi_hash;

    // Internal: Poseidon-based position commitments
    signal pos_commit_before;
    signal pos_commit_after;

    // ────────────────────────────────────────────────────────────────────────
    // Step 1: pos_commit_before = Poseidon3(pos_x, pos_y, pos_nonce)
    // ────────────────────────────────────────────────────────────────────────
    component pcom_before = Poseidon(3);
    pcom_before.inputs[0] <== pos_x;
    pcom_before.inputs[1] <== pos_y;
    pcom_before.inputs[2] <== pos_nonce;
    pos_commit_before <== pcom_before.out;

    // ────────────────────────────────────────────────────────────────────────
    // Step 2: Path starts at (pos_x, pos_y)
    // ────────────────────────────────────────────────────────────────────────
    path_x[0] === pos_x;
    path_y[0] === pos_y;

    // ────────────────────────────────────────────────────────────────────────
    // Step 3: Validate each step (adjacency, in-bounds, no wall)
    // ────────────────────────────────────────────────────────────────────────
    component step_lt[6];
    component adj[6];
    component bnd[6];
    component wall_chk[6];
    signal cell_step[6];
    signal adj_c[6];
    signal bnd_c[6];
    signal wall_c[6];

    for (var s = 0; s < 6; s++) {
        // step active iff s < path_len
        step_lt[s] = LessThan(4);
        step_lt[s].in[0] <== s;
        step_lt[s].in[1] <== path_len;

        adj[s] = IsAdjacent();
        adj[s].x0 <== path_x[s];   adj[s].y0 <== path_y[s];
        adj[s].x1 <== path_x[s+1]; adj[s].y1 <== path_y[s+1];

        bnd[s] = InBounds12();
        bnd[s].x <== path_x[s+1];
        bnd[s].y <== path_y[s+1];

        cell_step[s] <== path_y[s+1] * 12 + path_x[s+1];

        wall_chk[s] = BitIsSet();
        wall_chk[s].bitset <== map_walls;
        wall_chk[s].bit_index <== cell_step[s];

        // if active: adj must be 1, bounds must be 1, wall must be 0
        adj_c[s]  <== step_lt[s].out * (1 - adj[s].valid);
        adj_c[s]  === 0;

        bnd_c[s]  <== step_lt[s].out * (1 - bnd[s].valid);
        bnd_c[s]  === 0;

        wall_c[s] <== step_lt[s].out * wall_chk[s].out;
        wall_c[s] === 0;
    }

    // ────────────────────────────────────────────────────────────────────────
    // Step 4: Compute end position = path[path_len]
    // ────────────────────────────────────────────────────────────────────────
    component is_len[7];
    signal ex_acc[8];
    signal ey_acc[8];
    ex_acc[0] <== 0;
    ey_acc[0] <== 0;

    for (var i = 0; i < 7; i++) {
        is_len[i] = IsEqual();
        is_len[i].in[0] <== path_len;
        is_len[i].in[1] <== i;
        ex_acc[i+1] <== ex_acc[i] + is_len[i].out * path_x[i];
        ey_acc[i+1] <== ey_acc[i] + is_len[i].out * path_y[i];
    }
    signal end_x <== ex_acc[7];
    signal end_y <== ey_acc[7];

    // ────────────────────────────────────────────────────────────────────────
    // Step 5: Count loot collected along the path
    // ────────────────────────────────────────────────────────────────────────
    component pos_lt[7];
    component loot_bit[7];
    signal cell_loot[7];
    signal loot_on_path[7];
    signal loot_acc[8];
    loot_acc[0] <== 0;

    for (var i = 0; i < 7; i++) {
        // position i is visited iff i <= path_len  ↔  i < path_len + 1
        pos_lt[i] = LessThan(4);
        pos_lt[i].in[0] <== i;
        pos_lt[i].in[1] <== path_len + 1;

        cell_loot[i] <== path_y[i] * 12 + path_x[i];

        loot_bit[i] = BitIsSet();
        loot_bit[i].bitset <== map_loot;
        loot_bit[i].bit_index <== cell_loot[i];

        loot_on_path[i] <== pos_lt[i].out * loot_bit[i].out;
        loot_acc[i+1] <== loot_acc[i] + loot_on_path[i];
    }
    loot_delta === loot_acc[7];

    // ────────────────────────────────────────────────────────────────────────
    // Step 6: pos_commit_after = Poseidon3(end_x, end_y, new_pos_nonce)
    // ────────────────────────────────────────────────────────────────────────
    component pcom_after = Poseidon(3);
    pcom_after.inputs[0] <== end_x;
    pcom_after.inputs[1] <== end_y;
    pcom_after.inputs[2] <== new_pos_nonce;
    pos_commit_after <== pcom_after.out;

    // ────────────────────────────────────────────────────────────────────────
    // Step 7: pi_hash = Poseidon2(h1, h2)
    //   h1 = Poseidon4(session_id, turn_index, player_tag, pos_commit_before)
    //   h2 = Poseidon4(pos_commit_after, score_delta, loot_delta, no_path_flag)
    // ────────────────────────────────────────────────────────────────────────
    component h1 = Poseidon(4);
    h1.inputs[0] <== session_id;
    h1.inputs[1] <== turn_index;
    h1.inputs[2] <== player_tag;
    h1.inputs[3] <== pos_commit_before;

    component h2 = Poseidon(4);
    h2.inputs[0] <== pos_commit_after;
    h2.inputs[1] <== score_delta;
    h2.inputs[2] <== loot_delta;
    h2.inputs[3] <== no_path_flag;

    component pi_hasher = Poseidon(2);
    pi_hasher.inputs[0] <== h1.out;
    pi_hasher.inputs[1] <== h2.out;

    pi_hash <== pi_hasher.out;
}

component main = TurnValidity();
