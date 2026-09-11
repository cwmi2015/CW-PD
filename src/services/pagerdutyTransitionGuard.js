// Suppresses the temporary resolved webhook generated during an
// acknowledged-to-triggered transition.
const guardedIncidents = new Map();
const GUARD_TTL_MS = 60 * 1000;

function normalizeId(incidentId) {
  return String(incidentId || "");
}

function markSyntheticResolution(incidentId) {
  const id = normalizeId(incidentId);
  if (id) guardedIncidents.set(id, Date.now() + GUARD_TTL_MS);
}

function isSyntheticResolution(incidentId) {
  const id = normalizeId(incidentId);
  const expiresAt = guardedIncidents.get(id);

  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    guardedIncidents.delete(id);
    return false;
  }

  return true;
}

function clearSyntheticResolution(incidentId) {
  guardedIncidents.delete(normalizeId(incidentId));
}

module.exports = {
  markSyntheticResolution,
  isSyntheticResolution,
  clearSyntheticResolution,
};
