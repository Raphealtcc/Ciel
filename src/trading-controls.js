const CONTROL_TABLE = "ciel_control_flags";
const CONTROL_CACHE_PREFIX = "ciel:control-cache:v1:";
const CONTROL_CACHE_FRESH_MS = 5 * 60 * 1e3;
const CONTROL_CACHE_MAX_STALE_MS = 6 * 60 * 60 * 1e3;
const CONTROL_CACHE_TTL_SECONDS = 8 * 60 * 60;

function assertReadDatabase(env) {
  if (!env?.DB?.prepare) throw new Error("TRADING_CONTROL_D1_BINDING_UNAVAILABLE");
}
function assertWriteDatabase(env) {
  assertReadDatabase(env);
  if (typeof env.DB.batch !== "function") throw new Error("TRADING_CONTROL_D1_BATCH_UNAVAILABLE");
}
async function readControlCache(env, key) {
  if (typeof env?.CIEL_STATE?.get !== "function") return null;
  try {
    const raw = await env.CIEL_STATE.get(CONTROL_CACHE_PREFIX + String(key));
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!value || typeof value.cachedAt !== "number" || !Number.isFinite(value.cachedAt)) return null;
    return value;
  } catch {
    return null;
  }
}
async function writeControlCache(env, key, value, now) {
  if (typeof env?.CIEL_STATE?.put !== "function") return;
  await env.CIEL_STATE.put(
    CONTROL_CACHE_PREFIX + String(key),
    JSON.stringify({ value, cachedAt: now }),
    { expirationTtl: CONTROL_CACHE_TTL_SECONDS },
  ).catch(() => void 0);
}

export async function readTradingControl(env, key, fallback = null) {
  const now = Date.now();
  const cached = await readControlCache(env, key);
  if (cached && now - cached.cachedAt >= 0 && now - cached.cachedAt < CONTROL_CACHE_FRESH_MS) {
    return cached.value ?? fallback;
  }
  try {
    assertReadDatabase(env);
    const row = await env.DB.prepare(
      "SELECT control_value FROM " + CONTROL_TABLE + " WHERE control_key = ?1"
    ).bind(String(key)).first();
    const value = row?.control_value ?? fallback;
    await writeControlCache(env, key, value, now);
    return value;
  } catch (error) {
    if (cached && now - cached.cachedAt >= 0 && now - cached.cachedAt <= CONTROL_CACHE_MAX_STALE_MS) {
      console.warn("Trading control D1 read unavailable; using cached value for " + String(key));
      return cached.value ?? fallback;
    }
    return fallback;
  }
}

export async function writeTradingControls(env, entries, now = Date.now()) {
  assertWriteDatabase(env);
  if (!Array.isArray(entries) || !entries.length) throw new Error("TRADING_CONTROL_UPDATE_EMPTY");
  const allowed = new Set([
    "ciel:control:paper-enabled",
    "ciel:control:live-enabled",
    "ciel:control:live-entry-enabled",
  ]);
  const statements = entries.map(([key, enabled]) => {
    if (!allowed.has(key) || typeof enabled !== "boolean") throw new Error("TRADING_CONTROL_UPDATE_INVALID");
    return env.DB.prepare(
      "INSERT INTO " + CONTROL_TABLE + " (control_key, control_value, updated_at_ms) VALUES (?1, ?2, ?3) " +
      "ON CONFLICT(control_key) DO UPDATE SET control_value = excluded.control_value, updated_at_ms = excluded.updated_at_ms"
    ).bind(key, String(enabled), now);
  });
  const results = await env.DB.batch(statements);
  if (!Array.isArray(results) || results.length !== statements.length ||
      results.some((result) => result?.success === false || result?.error)) {
    throw new Error("TRADING_CONTROL_D1_WRITE_FAILED");
  }
  await Promise.all(entries.map(([key, enabled]) => writeControlCache(env, key, String(enabled), now)));
  return results;
}
