// HTTP odjemalec: User-Agent, časovna omejitev, razmik med klici po viru,
// ponovni poskusi z eksponentnim zamikom ob 429/5xx, števec klicev po viru.

export class HttpError extends Error {
  constructor(message, { status = null, code = null, url = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.url = url;
  }
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// HTTP glave smejo vsebovati le tiskljive znake ASCII (fetch sicer vrže napako ByteString).
export function assertHeaderValue(name, value) {
  if (typeof value !== 'string' || !/^[\x20-\x7e]*$/.test(value)) {
    throw new Error(`Glava ${name} sme vsebovati le tiskljive znake ASCII: ${JSON.stringify(value)}`);
  }
}

export function createHttpClient(cfg, { fetchImpl = globalThis.fetch, sleep = realSleep, now = Date.now } = {}) {
  const h = cfg.http;
  assertHeaderValue('User-Agent', cfg.app.userAgent);
  const lastCall = new Map();
  const calls = {};

  async function throttle(provider) {
    const minGap = cfg.providers?.[provider]?.minIntervalMs ?? 0;
    const prev = lastCall.get(provider);
    if (prev !== undefined) {
      const wait = prev + minGap - now();
      if (wait > 0) await sleep(wait);
    }
    lastCall.set(provider, now());
  }

  function backoffMs(attempt, retryAfterHeader) {
    const ra = Number(retryAfterHeader);
    if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, h.backoffMaxMs);
    return Math.min(h.backoffBaseMs * 2 ** (attempt - 1), h.backoffMaxMs);
  }

  /**
   * @param provider ključ vira (za razmik in štetje klicev)
   * @param url polni URL
   * @param opts.as 'json' | 'text' | 'buffer'
   * @param opts.passStatuses statusi, ki se vrnejo klicatelju brez napake (npr. [400, 404])
   */
  async function request(provider, url, { as = 'json', passStatuses = [], headers = {} } = {}) {
    let lastErr = null;
    const throttleKey = provider.split(':')[0];
    for (const [k, v] of Object.entries(headers)) assertHeaderValue(k, v);
    for (let attempt = 1; attempt <= h.maxAttempts; attempt++) {
      await throttle(throttleKey);
      calls[provider] = (calls[provider] ?? 0) + 1;
      let res;
      try {
        res = await fetchImpl(url, {
          headers: { 'User-Agent': cfg.app.userAgent, Accept: as === 'json' ? 'application/json' : '*/*', ...headers },
          signal: AbortSignal.timeout(h.timeoutMs),
        });
      } catch (err) {
        lastErr = new HttpError(`omrežna napaka: ${err.message}`, { code: 'NETWORK', url });
        if (attempt < h.maxAttempts) await sleep(backoffMs(attempt));
        continue;
      }

      if (res.status === 451) {
        throw new HttpError(
          'HTTP 451: vir ni dosegljiv s te lokacije (geografska omejitev). Za Binance uporabi data-api.binance.vision.',
          { status: 451, code: 'GEO_BLOCKED', url },
        );
      }
      if (h.retryOn.includes(res.status)) {
        lastErr = new HttpError(`HTTP ${res.status}`, { status: res.status, code: 'RETRYABLE', url });
        if (attempt < h.maxAttempts) await sleep(backoffMs(attempt, res.headers.get('retry-after')));
        continue;
      }
      if (!res.ok && !passStatuses.includes(res.status)) {
        let detail = '';
        try {
          detail = (await res.text()).slice(0, 300);
        } catch {
          /* ignoriraj */
        }
        throw new HttpError(`HTTP ${res.status} ${detail}`.trim(), { status: res.status, code: 'HTTP', url });
      }

      let data;
      if (as === 'json') {
        const text = await res.text();
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          throw new HttpError(`neveljaven JSON: ${text.slice(0, 200)}`, { status: res.status, code: 'PARSE', url });
        }
      } else if (as === 'text') {
        data = await res.text();
      } else {
        data = Buffer.from(await res.arrayBuffer());
      }
      return { status: res.status, data };
    }
    throw lastErr;
  }

  return {
    request,
    stats: () => ({ ...calls }),
  };
}
