/**
 * Where a plan lives. The plan itself is a file in the project (.choo-choo/plans/<name>.plan.md),
 * so it travels with git. What happened when it ran (which workspace does which task, what merged)
 * is kept in the add-on's own storage, so running a plan makes no commits.
 *
 * Only the background page writes that state. Views ask for changes by leaving a request
 * (`req:<id>`), which the background page picks up; that way two pages never overwrite each other.
 */
import { NAME_RE, parsePlan } from './plan.js'

const DIR = 'plans'
const EXT = '.plan.md'
/** A storage key touched whenever a plan file is written, so every open page reads the files again. */
export const FILES_KEY = 'files'

export const planPath = (name) => `${DIR}/${name}${EXT}`
export const stateKey = (repoId, name) => `state:${repoId}/${name}`
export const emptyState = () => ({ auto: false, tasks: {} })

export function parseStateKey(key) {
  const m = /^state:([^/]+)\/(.+)$/.exec(key)
  return m ? { repoId: m[1], name: m[2] } : null
}

export async function listPlans(repoId) {
  const files = await choo.files.list(repoId, DIR)
  return files
    .filter((f) => f.path.startsWith(`${DIR}/`) && f.path.endsWith(EXT))
    .map((f) => ({ name: f.path.slice(DIR.length + 1, -EXT.length), modified: f.modified }))
    .filter((p) => NAME_RE.test(p.name))
}

/** The plans with their titles, for a list a person picks from. */
export async function listPlanTitles(repoId) {
  const plans = await listPlans(repoId)
  return Promise.all(plans.map(async (p) => ({ ...p, title: (await readPlan(repoId, p.name))?.plan.title ?? p.name })))
}

/** The plan file, read and checked. Null when there is no such plan. */
export async function readPlan(repoId, name) {
  const file = await choo.files.read(repoId, planPath(name))
  if (!file) return null
  const plan = parsePlan(file.content)
  if (!plan.title) plan.title = name
  return { name, text: file.content, modified: file.modified, plan }
}

export async function writePlan(repoId, name, text) {
  if (!NAME_RE.test(name)) throw new Error('A plan name is lowercase letters, digits and dashes, at most 32 characters. For example billing-v2.')
  await choo.files.write(repoId, planPath(name), text.endsWith('\n') ? text : `${text}\n`)
  await choo.store.set(FILES_KEY, Date.now())
}

export async function deletePlan(repoId, name) {
  await choo.files.delete(repoId, planPath(name))
  await choo.store.set(FILES_KEY, Date.now())
}

export async function readState(repoId, name) {
  const s = await choo.store.get(stateKey(repoId, name))
  return s && typeof s === 'object' ? { ...emptyState(), ...s, tasks: s.tasks ?? {} } : emptyState()
}

/**
 * Ask the background page to change a plan's state.
 *   run / pause            the whole plan
 *   refresh                look at every pull request now
 *   start (taskId, force)  one task now, whatever the parallel limit says
 *   done / undone (taskId) tick a task off by hand, or take the tick back
 *   reset (taskId)         forget the task's workspace, so it can start again
 */
export function request(repoId, name, action, more = {}) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return choo.store.set(`req:${id}`, { repoId, name, action, ...more })
}
