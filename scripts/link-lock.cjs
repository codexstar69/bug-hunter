'use strict';

const fs = require('fs');
const path = require('path');

const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isDeadLocalPid(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    if (error.code === 'EPERM') return false;
    throw error;
  }
}

// A link lock is a hard link of its owner's `<lock>.<token>.tmp` record. To
// remove the generation of a dead local owner, a reclaimer renames that record
// to `<lock>.<token>.claim.<pid>`: only one process can move it, and nobody
// else removes the lock while the claim exists, so no process ever unlinks a
// generation it did not win. A claimer killed mid-claim is itself claimed once
// its PID is dead.
//
// Returns 'reclaimed' or 'retry' (a racing reclaimer already removed that
// generation); returns 'busy' while another live process holds the claim.
function reclaimDeadLinkLock(lockPath, owner) {
  if (typeof owner.token !== 'string' || !TOKEN_PATTERN.test(owner.token)) {
    throw new Error(`Malformed lock owner record: ${lockPath}`);
  }
  const directory = path.dirname(lockPath);
  const claimPrefix = `${path.basename(lockPath)}.${owner.token}.claim.`;
  const claim = path.join(directory, `${claimPrefix}${process.pid}`);
  const sources = [`${lockPath}.${owner.token}.tmp`];
  let liveClaim = false;
  for (const name of fs.readdirSync(directory)) {
    if (!name.startsWith(claimPrefix)) continue;
    const suffix = name.slice(claimPrefix.length);
    const pid = /^[1-9][0-9]*$/.test(suffix) ? Number(suffix) : 0;
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
    if (isDeadLocalPid(pid)) sources.push(path.join(directory, name));
    else liveClaim = true;
  }
  for (const source of sources) {
    try {
      fs.renameSync(source, claim);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    // The owner may have died between removing its lock and its record, so a
    // newer generation can hold the path: remove the lock only while it is
    // still a link of the claimed record.
    const claimed = fs.lstatSync(claim, { bigint: true });
    const current = fs.lstatSync(lockPath, { bigint: true, throwIfNoEntry: false });
    if (current && current.ino === claimed.ino && current.dev === claimed.dev) fs.unlinkSync(lockPath);
    fs.unlinkSync(claim);
    return 'reclaimed';
  }
  if (liveClaim) return 'busy';
  // Nothing left to claim: another reclaimer finished (the lock now names a new
  // owner or is gone), or the dead owner's record was removed by hand.
  let record;
  try {
    record = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return 'retry';
    throw error;
  }
  if (record && record.token === owner.token) {
    // A reclaimer that claimed the record after our listing is still finishing.
    if (fs.readdirSync(directory).some((name) => name.startsWith(claimPrefix))) return 'retry';
    throw new Error(`Stale lock has no owner record; remove it after checking no runner is active: ${lockPath}`);
  }
  return 'retry';
}

module.exports = { isDeadLocalPid, reclaimDeadLinkLock };
