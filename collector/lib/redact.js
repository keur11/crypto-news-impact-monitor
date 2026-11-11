// Maskiranje skrivnosti v izhodih (status.json, dnevniki, artifacti, izpis v konzolo).
// GitHub Actions maskira secrets samo v dnevniku teka, ne v datotekah artifactov, zato maskiramo sami.

export const MASK = '***';

/** Vrednosti okoljskih spremenljivk iz cfg.app.secretEnvs (prazne in prekratke se ne maskirajo). */
export function secretValues(cfg, env = process.env) {
  return (cfg.app?.secretEnvs ?? [])
    .map((k) => String(env[k] ?? '').trim())
    .filter((v) => v.length >= 4)
    .sort((a, b) => b.length - a.length);
}

export function redactString(s, secrets) {
  let out = s;
  for (const v of secrets) {
    out = out.split(v).join(MASK);
    // tudi URL-kodirana oblika (npr. v povezavi v sporočilu o napaki)
    const enc = encodeURIComponent(v);
    if (enc !== v) out = out.split(enc).join(MASK);
  }
  return out;
}

/** Globoka kopija z maskiranimi nizi (tudi ključi objektov). */
export function redact(value, secrets) {
  if (!secrets.length) return value;
  if (typeof value === 'string') return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((x) => redact(x, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [redactString(k, secrets), redact(v, secrets)]));
  }
  return value;
}
