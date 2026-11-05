const CONTROL_TABLE = "ciel_control_flags";

function assertDatabase(env) {
  if (!env?.DB?.prepare || typeof env.DB.batch !== "function") {
    throw new Error("TRADING_CONTROL_D1_BINDING_UNAVAILABLE");
  }
}

export async function readTradingControl(env, key, fallback = null) {
  assertDatabase(env);
  const row = await env.DB.prepare(
    "SELECT control_value FROM " + CONTROL_TABLE + " WHERE control_key = ?1"
  ).bind(String(key)).first();
  return row?.control_value ?? fallback;
}

export async function writeTradingControls(env, entries, now = Date.now()) {
  assertDatabase(env);
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
  return results;
}
