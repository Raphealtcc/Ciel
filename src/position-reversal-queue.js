export const CIEL_POSITION_REVERSAL_QUEUE_KEY = "ciel:position-reversal:queue:v1";

const activeStates = new Set(["WAITING_CLOSE_CONFIRMATION", "CLOSE_CONFIRMED", "ENTRY_SUBMITTED"]);

export function normalizePositionReversalQueue(value, now = Date.now()) {
  const items = Array.isArray(value) ? value : [];
  return items.filter((item) =>
    item && typeof item.id === "string" &&
    activeStates.has(String(item.status || "")) &&
    Number(item.expiresAt) > Number(now) &&
    String(item.symbol || "").trim() &&
    ["LONG", "SHORT"].includes(String(item.side || "").toUpperCase())
  ).slice(-20);
}

export function reconcilePositionReversalQueue(queueValue, positions, now = Date.now()) {
  const queue = normalizePositionReversalQueue(queueValue, now);
  const open = Array.isArray(positions) ? positions : [];
  let changed = false;
  for (const item of queue) {
    if (item.status === "WAITING_CLOSE_CONFIRMATION") {
      const oldStillOpen = open.some((position) =>
        String(position.positionHash || position.hash || "").toLowerCase() ===
        String(item.positionHash || "").toLowerCase()
      );
      if (!oldStillOpen) {
        item.status = "CLOSE_CONFIRMED";
        item.closeConfirmedAt = Number(now);
        item.nextAttemptAt = Number(now);
        changed = true;
      }
    } else if (item.status === "ENTRY_SUBMITTED") {
      const oppositePositionFound = open.some((position) =>
        item.entrySignalId
          ? String(position.signalId || "") === String(item.entrySignalId)
          : String(position.symbol || "").toUpperCase() === String(item.symbol).toUpperCase() &&
            String(position.side || "").toUpperCase() === String(item.side).toUpperCase() &&
            String(position.positionHash || position.hash || "").toLowerCase() !== String(item.positionHash || "").toLowerCase()
      );
      if (oppositePositionFound) {
        item.status = "COMPLETED";
        item.completedAt = Number(now);
        changed = true;
      }
    }
  }
  return { queue, changed };
}

export function matchPositionReversalRequest(queueValue, candidate, now = Date.now()) {
  if (!candidate?.symbol || !candidate?.side) return null;
  return normalizePositionReversalQueue(queueValue, now).find((item) =>
    item.status === "CLOSE_CONFIRMED" &&
    Number(item.nextAttemptAt || 0) <= Number(now) &&
    String(item.symbol).toUpperCase() === String(candidate.symbol).toUpperCase() &&
    String(item.side).toUpperCase() === String(candidate.side).toUpperCase()
  ) || null;
}

export function updatePositionReversalRequest(queueValue, id, patch, now = Date.now()) {
  const queue = normalizePositionReversalQueue(queueValue, now);
  let changed = false;
  const next = queue.map((item) => {
    if (item.id !== id) return item;
    changed = true;
    return { ...item, ...patch, updatedAt: Number(now) };
  });
  return { queue: next, changed };
}
