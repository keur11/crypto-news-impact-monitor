// GDELT DOC 2.0 – razširitvena točka, v MVP izklopljena.
// Namen: širjenje zgodbe v splošnih medijih (število člankov v časovnici).
// Omejitev: načini razen časovnice upoštevajo le zadnje 3 mesece iskalnega okna.

export const enabled = false;

/** @returns {Promise<{ ok: boolean, skipped?: boolean, error?: string, timeline?: Array }>} */
export async function fetchCoverage(/* http, cfg, query, fromMs, toMs */) {
  return { ok: false, skipped: true, error: 'GDELT je v MVP izklopljen' };
}
