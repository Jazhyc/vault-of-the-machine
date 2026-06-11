// The sky-sigil mechanic's pure logic, shared by the server (rolls & validates
// codes) and the test suite (asserts pattern invariants). The client never
// rolls — it renders whatever the snapshot carries.
//
// The lattice is a 3x3 grid of star-nodes indexed row-major:
//   0 1 2
//   3 4 5
//   6 7 8
// A node set is a 9-bit mask (bit i = node i lit).

// Every straight run on the lattice: 3 rows + 3 columns + 2 diagonals,
// each contributing its full 3-node line and both 2-node sub-segments.
const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // horizontal
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // vertical
  [0, 4, 8], [2, 4, 6],            // diagonal
];
export const SIGIL_SEGMENTS = LINES.flatMap(l => [l, [l[0], l[1]], [l[1], l[2]]]);

export const maskOf = (nodes) => nodes.reduce((m, i) => m | (1 << i), 0);

const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// Roll one round's sigil layout:
//   colors — permutation of pedestal indices [twin A, twin B, final herald]
//   owners — per arena pillar (6), which twin (0|1) its panel belongs to (3/3 split)
//   segs   — per pillar, its line segment (2-3 nodes)
//   codes  — per twin, the union mask of its three pillar segments
// The two codes are guaranteed distinct, or matching one would drop both wards.
export function rollSigil() {
  let roll;
  for (let attempt = 0; attempt < 100; attempt++) {
    const colors = shuffle([0, 1, 2]);
    const owners = shuffle([0, 0, 0, 1, 1, 1]);
    const segs = owners.map(() => SIGIL_SEGMENTS[Math.floor(Math.random() * SIGIL_SEGMENTS.length)]);
    const codes = [0, 1].map(side =>
      segs.reduce((m, seg, i) => owners[i] === side ? m | maskOf(seg) : m, 0));
    roll = { colors, owners, segs, codes };
    if (codes[0] !== codes[1]) return roll;
  }
  // Statistically unreachable; force two trivially distinct codes (top row vs
  // bottom row) rather than loop forever.
  roll.segs = roll.owners.map(o => o === 0 ? [0, 1, 2] : [6, 7, 8]);
  roll.codes = [maskOf([0, 1, 2]), maskOf([6, 7, 8])];
  return roll;
}

// World position of lattice node i (the grid hangs flat over the arena center).
export const sigilNodePos = (i, { gridY, gridGap }) => [
  ((i % 3) - 1) * gridGap, gridY, (Math.floor(i / 3) - 1) * gridGap,
];
