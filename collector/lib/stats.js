// Čiste statistične funkcije. Brez stanja, brez odvisnosti.

function assertNumbers(arr, name) {
  if (!Array.isArray(arr)) throw new TypeError(`${name} mora biti tabela`);
  for (const x of arr) {
    if (typeof x !== 'number' || !Number.isFinite(x)) {
      throw new TypeError(`${name} vsebuje neštevilsko vrednost: ${x}`);
    }
  }
}

export function sum(arr) {
  assertNumbers(arr, 'sum');
  let s = 0;
  for (const x of arr) s += x;
  return s;
}

export function mean(arr) {
  if (arr.length === 0) return null;
  return sum(arr) / arr.length;
}

// Vzorčna varianca (imenovalec n − 1).
export function sampleVariance(arr) {
  assertNumbers(arr, 'sampleVariance');
  if (arr.length < 2) return null;
  const m = mean(arr);
  let ss = 0;
  for (const x of arr) ss += (x - m) ** 2;
  return ss / (arr.length - 1);
}

export function sampleStd(arr) {
  const v = sampleVariance(arr);
  return v === null ? null : Math.sqrt(v);
}

// Vzorčna kovarianca (imenovalec n − 1).
export function covariance(a, b) {
  assertNumbers(a, 'covariance(a)');
  assertNumbers(b, 'covariance(b)');
  if (a.length !== b.length) throw new Error('covariance: tabeli nista enako dolgi');
  if (a.length < 2) return null;
  const ma = mean(a);
  const mb = mean(b);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / (a.length - 1);
}

// β = Cov(ra, rb) / Var(rb). Vrne null, če je Var(rb) = 0 ali je podatkov premalo.
export function beta(ra, rb) {
  const v = sampleVariance(rb);
  if (v === null || v === 0) return null;
  return covariance(ra, rb) / v;
}

export function median(arr) {
  const xs = arr.filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (xs.length === 0) return null;
  xs.sort((x, y) => x - y);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

export function clip(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

export function logReturn(prevClose, close) {
  if (!(prevClose > 0) || !(close > 0)) {
    throw new Error(`logReturn: cene morajo biti pozitivne (${prevClose}, ${close})`);
  }
  return Math.log(close / prevClose);
}

/** Rangi z povprečjem pri izenačenjih (1 = najmanjši). */
export function ranks(arr) {
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = Array(arr.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}

export function pearson(a, b) {
  const v = Math.sqrt(sampleVariance(a) * sampleVariance(b));
  return v > 0 ? covariance(a, b) / v : null;
}

/** Spearmanov ρ = Pearson na rangih (s povprečnimi rangi pri izenačenjih). */
export function spearman(a, b) {
  if (a.length !== b.length || a.length < 3) return null;
  return pearson(ranks(a), ranks(b));
}

// Zaokroževanje za stabilen zapis v JSON (determinističen izhod, berljivost).
export function round(x, digits = 6) {
  if (x === null || x === undefined || !Number.isFinite(x)) return x ?? null;
  const f = 10 ** digits;
  const r = Math.round(x * f) / f;
  return Object.is(r, -0) ? 0 : r;
}
