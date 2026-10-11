const GROUPS = {
  time: ['date', 'start', 'end', 'endNextDay'],
  tasks: ['tasks'],
  jobId: ['jobId'],
};

const clone = row => row ? {...row} : null;
const sameGroup = (a, b, group) => GROUPS[group].every(field => a[field] === b[field]);
const differences = (a, b) => Object.keys(GROUPS).filter(group => !sameGroup(a, b, group));
const sameEntry = (a, b) => differences(a, b).length === 0;

/**
 * Merge normalized records against the last state observed by both writers.
 * Time fields form one indivisible value: combining separately edited start/end
 * values could silently create a work interval neither writer entered.
 *
 * Conflicted records retain the complete local value (including a local delete)
 * until the caller explicitly resolves them. Callers must not save a merge with
 * unresolved conflicts. All returned records are detached from the inputs.
 */
export function mergeEntries(baseEntries, localEntries, remoteEntries) {
  const base = new Map(baseEntries.map(row => [row.id, row]));
  const local = new Map(localEntries.map(row => [row.id, row]));
  const remote = new Map(remoteEntries.map(row => [row.id, row]));
  const ids = new Set([...remote.keys(), ...local.keys(), ...base.keys()]);
  const entries = [];
  const conflicts = [];

  const conflict = (id, kind, fields, b, l, r) => {
    conflicts.push({id, kind, fields, base: clone(b), local: clone(l), remote: clone(r)});
    if (l) entries.push(clone(l));
  };

  for (const id of ids) {
    const b = base.get(id), l = local.get(id), r = remote.get(id);
    if (!b) {
      if (l && r && !sameEntry(l, r)) conflict(id, 'add-add', differences(l, r), b, l, r);
      else if (l || r) entries.push(clone(r || l));
      continue;
    }
    if (!l && !r) continue;
    if (!l) {
      if (!sameEntry(b, r)) conflict(id, 'delete-edit', differences(b, r), b, l, r);
      continue;
    }
    if (!r) {
      if (!sameEntry(b, l)) conflict(id, 'edit-delete', differences(b, l), b, l, r);
      continue;
    }

    const merged = clone(r), fields = [];
    for (const group of Object.keys(GROUPS)) {
      if (sameGroup(l, r, group) || sameGroup(l, b, group)) continue;
      if (sameGroup(r, b, group)) {
        for (const field of GROUPS[group]) merged[field] = l[field];
      } else fields.push(group);
    }
    if (fields.length) conflict(id, 'edit-edit', fields, b, l, r);
    else entries.push(merged);
  }
  return {entries, conflicts};
}
