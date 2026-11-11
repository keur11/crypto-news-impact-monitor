// X (Twitter) Snowflake ID → čas objave.
// timestamp_ms = (id >> 22) + 1288834974657  (epoha Twitterja: 2010-11-04T01:42:54.657Z)

export const X_EPOCH_MS = 1288834974657n;

export function snowflakeToMs(id) {
  if (typeof id !== 'string' || !/^\d+$/.test(id)) throw new Error(`Neveljaven Snowflake ID: ${id}`);
  return Number((BigInt(id) >> 22n) + X_EPOCH_MS);
}

export function tweetIdFromUrl(url) {
  const m = /(?:twitter|x)\.com\/[^/]+\/status\/(\d+)/.exec(url ?? '');
  return m ? m[1] : null;
}
