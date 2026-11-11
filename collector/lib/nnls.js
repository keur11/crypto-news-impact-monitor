// Nenegativni najmanjši kvadrati (NNLS) za majhno število spremenljivk (p ≤ ~10).
// Natančna rešitev: preizkusi vse podmnožice aktivnih spremenljivk, na vsaki reši OLS
// (normalne enačbe, Gaussova eliminacija) in obdrži dopustno rešitev z najmanjšo vsoto kvadratov.
// Rešitev KKT problema NNLS je OLS na neki podmnožici z nenegativnimi koeficienti.

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null; // singularno
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

function sse(X, y, w) {
  let s = 0;
  for (let i = 0; i < y.length; i++) {
    let p = 0;
    for (let j = 0; j < w.length; j++) p += X[i][j] * w[j];
    s += (y[i] - p) ** 2;
  }
  return s;
}

/** @returns { weights: number[], sse: number } */
export function nnls(X, y) {
  const p = X[0]?.length ?? 0;
  if (p > 12) throw new Error('nnls: preveč spremenljivk za izčrpno iskanje');
  let best = { weights: Array(p).fill(0), sse: sse(X, y, Array(p).fill(0)) };
  for (let mask = 1; mask < 1 << p; mask++) {
    const idx = [];
    for (let j = 0; j < p; j++) if (mask & (1 << j)) idx.push(j);
    const XtX = idx.map((a) => idx.map((b) => X.reduce((s, row) => s + row[a] * row[b], 0)));
    const Xty = idx.map((a) => X.reduce((s, row, i) => s + row[a] * y[i], 0));
    const sol = solve(XtX, Xty);
    if (!sol || sol.some((v) => v < -1e-12)) continue;
    const w = Array(p).fill(0);
    idx.forEach((j, k) => (w[j] = Math.max(0, sol[k])));
    const e = sse(X, y, w);
    if (e < best.sse - 1e-15) best = { weights: w, sse: e };
  }
  return best;
}
