// TF-IDF naslovov v čistem JS: tokenizacija, angleške stop-besede, lahko krnjenje, kosinusna podobnost.

const STOP = new Set(
  `a about above after again against all also am an and any are as at be because been before being below between both but by
  can could did do does doing down during each few for from further had has have having he her here hers him his how i if in
  into is it its itself just me more most my no nor not now of off on once only or other our ours out over own same she should
  so some such than that the their theirs them then there these they this those through to too under until up very was we
  were what when where which while who whom why will with would you your yours says said say new amid via vs as per
  heres whats hows why's here's what's`.split(/\s+/).filter(Boolean),
);

const UNITS = [
  [/(\d+(?:\.\d+)?)\s*(?:bn|b|billion)(?![a-z])/gi, '$1 billion'],
  [/(\d+(?:\.\d+)?)\s*(?:mn|m|million)(?![a-z])/gi, '$1 million'],
  [/(\d+(?:\.\d+)?)\s*(?:k|thousand)(?![a-z])/gi, '$1 thousand'],
  [/(\d+(?:\.\d+)?)\s*%/g, '$1 percent'],
];

export function stem(t) {
  if (/^\d/.test(t) || t.length <= 3) return t;
  if (t.endsWith('ies') && t.length > 4) return `${t.slice(0, -3)}y`;
  if (t.endsWith('sses')) return t.slice(0, -2);
  if (/(?:xes|zes|ches|shes)$/.test(t)) return t.slice(0, -2);
  if (t.endsWith('ing') && t.length > 5) return t.slice(0, -3);
  if (t.endsWith('ed') && t.length > 4) return t.slice(0, -2);
  if (t.endsWith('s') && !/(?:ss|us|is)$/.test(t)) return t.slice(0, -1);
  return t;
}

export function tokenize(text) {
  let s = String(text ?? '').replace(/[’']s(?![a-z])/gi, '').replace(/[’']/g, '');
  for (const [re, rep] of UNITS) s = s.replace(re, rep);
  s = s.replace(/\$/g, ' ').toLowerCase();
  return s
    .split(/[^a-z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

export function buildIdf(docsTokens) {
  const df = new Map();
  for (const toks of docsTokens) for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docsTokens.length;
  const idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log((n + 1) / (d + 1)) + 1);
  return { idf, n, unseen: Math.log(n + 1) + 1 };
}

export function vectorize(tokens, idfModel) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  const v = new Map();
  let norm = 0;
  for (const [t, c] of tf) {
    const w = c * (idfModel.idf.get(t) ?? idfModel.unseen);
    v.set(t, w);
    norm += w * w;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) for (const [t, w] of v) v.set(t, w / norm);
  return v;
}

export function cosine(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, w] of small) {
    const x = big.get(t);
    if (x !== undefined) dot += w * x;
  }
  return dot;
}
