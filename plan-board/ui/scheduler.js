/**
 * Moves plans forward. Runs in the background page, the only place that writes a plan's state:
 * it carries out the views' requests, keeps each task's pull request up to date, starts tasks whose
 * dependencies are done, and messages an agent whose checks fail. Also answers the orchestrator's
 * tools. Everything goes through one queue, so no two steps ever overlap.
 */
import { GUIDE, MAX_NUDGES, NAME_RE, STATUS, columns, decide, isDone, parsePlan, statuses, summary, summaryText, taskPrompt, waitingOn } from './plan.js'
import { FILES_KEY, emptyState, listPlans, parseStateKey, readPlan, readState, request, stateKey, writePlan } from './data.js'

/** A pull request nobody reported a change on is still looked at this often. */
const PR_EVERY_MS = 2 * 60_000

/** Pull requests the app said changed, and when each workspace's was last looked at. Lost on restart, which only costs one extra look. */
const prChanged = new Set()
const prSeen = new Map()
const lastStatus = new Map()

let queue = Promise.resolve()
/** Runs `fn` after everything already queued. */
export function serial(fn) {
  const run = queue.then(fn)
  queue = run.catch((e) => console.error(e))
  return run
}

export const prChangedFor = (workspaceId) => prChanged.add(workspaceId)

/** Forget what was learned about pull requests. For tests. */
export function forget() {
  prChanged.clear()
  prSeen.clear()
  lastStatus.clear()
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** One pass over every plan that has state or a request waiting. */
export async function tick(now = Date.now()) {
  const keys = await choo.store.keys()
  const targets = new Map()
  const target = (repoId, name) => {
    const k = `${repoId}/${name}`
    if (!targets.has(k)) targets.set(k, { repoId, name, requests: [] })
    return targets.get(k)
  }
  for (const key of keys) {
    if (key.startsWith('state:')) {
      const at = parseStateKey(key)
      if (at) target(at.repoId, at.name)
    } else if (key.startsWith('req:')) {
      const r = await choo.store.get(key)
      await choo.store.delete(key)
      if (r && typeof r.repoId === 'string' && typeof r.name === 'string' && NAME_RE.test(r.name)) target(r.repoId, r.name).requests.push(r)
    }
  }
  const lists = new Map()
  const workspacesOf = async (repoId) => {
    if (!lists.has(repoId)) lists.set(repoId, await choo.workspaces.list({ repoId }))
    return lists.get(repoId)
  }
  for (const t of targets.values()) {
    try {
      await advance(t, await workspacesOf(t.repoId), now)
    } catch (e) {
      // One broken plan (its project was removed, say) doesn't hold up the others.
      console.error(`Plan ${t.name}:`, e)
    }
  }
}

async function advance({ repoId, name, requests }, workspaces, now) {
  const key = stateKey(repoId, name)
  const saved = await choo.store.get(key)
  const file = await readPlan(repoId, name)
  if (!file) {
    // The plan file was deleted or renamed. Its workspaces stay; the plan's memory of them goes.
    if (saved) await choo.store.delete(key)
    return
  }
  const plan = file.plan
  const state = saved && typeof saved === 'object' ? structuredClone({ ...emptyState(), ...saved, tasks: saved.tasks ?? {} }) : emptyState()
  const byId = new Map(plan.tasks.map((t) => [t.id, t]))
  const live = new Map(workspaces.map((w) => [w.id, w]))
  const record = (id) => (state.tasks[id] ??= {})
  const notify = (title, body, workspaceId) => choo.ui.notify(clip(title, 80), clip(body ?? '', 240), workspaceId).catch(() => {})

  const start = async (task) => {
    const rec = (state.tasks[task.id] = {})
    try {
      const ws = await choo.workspaces.start({ repoId, task: taskPrompt(plan, task), title: clip(task.title, 80), ...(task.model || plan.model ? { model: task.model || plan.model } : {}) })
      Object.assign(rec, { ws: ws.id, branch: ws.branch, startedAt: now })
      workspaces.push(ws)
      live.set(ws.id, ws)
      return true
    } catch (e) {
      const message = String(e?.message ?? e)
      // The app's own limit on agents per add-on: not this task's fault, so it stays ready.
      if (/agents running/.test(message)) delete state.tasks[task.id]
      else rec.error = message
      return false
    }
  }

  for (const r of requests) {
    const task = byId.get(r.taskId)
    if (r.action === 'run') {
      state.auto = true
      delete state.finishedAt
      // Starting the plan again retries what couldn't start.
      for (const rec of Object.values(state.tasks)) if (!rec.ws) delete rec.error
    } else if (r.action === 'pause') state.auto = false
    else if (r.action === 'refresh') {
      for (const rec of Object.values(state.tasks)) if (rec.ws) prChanged.add(rec.ws)
    }
    else if (!task) continue
    else if (r.action === 'done') Object.assign(record(task.id), { doneAt: now })
    else if (r.action === 'undone') delete record(task.id).doneAt
    else if (r.action === 'reset') delete state.tasks[task.id]
    else if (r.action === 'start') {
      const st = statuses(plan, state.tasks, workspaces)[task.id]
      if (task.manual || plan.problems.length) continue
      if (st === 'ready' || (!state.tasks[task.id]?.ws && st === 'error') || st === 'gone' || (st === 'waiting' && r.force)) await start(task)
    }
  }

  // Pull requests: look when the app says one changed, when an agent just stopped, and now and then.
  for (const rec of Object.values(state.tasks)) {
    if (!rec.ws || rec.mergedAt || rec.doneAt) continue
    const ws = live.get(rec.ws)
    if (!ws) continue
    const stopped = ws.status === 'idle' && lastStatus.get(rec.ws) !== 'idle'
    lastStatus.set(rec.ws, ws.status)
    if (!prChanged.has(rec.ws) && !stopped && now - (prSeen.get(rec.ws) ?? 0) < PR_EVERY_MS) continue
    prChanged.delete(rec.ws)
    prSeen.set(rec.ws, now)
    try {
      const { pr, checks } = await choo.prs.status(rec.ws)
      if (pr) rec.pr = { number: pr.number, url: pr.url, state: pr.state, isDraft: pr.isDraft, review: pr.reviewDecision, mergeState: pr.mergeState, checks: { total: checks.total, passed: checks.passed, pending: checks.pending, failed: checks.failed.map((c) => c.name) } }
      // No pull request in the answer also means "couldn't reach GitHub": one that was seen is kept.
      if (pr?.state === 'MERGED') rec.mergedAt = now
    } catch {
      // The workspace went away between the list and this call.
    }
  }

  let status = statuses(plan, state.tasks, workspaces)
  const todo = decide(plan, state, status)
  for (const id of todo.start) {
    if (await start(byId.get(id))) continue
    // Whatever stopped this one would likely stop the next: pause instead of failing down the list.
    const error = state.tasks[id]?.error
    if (error) {
      state.auto = false
      notify(`Couldn't start ${byId.get(id).title}`, `The plan is paused. ${error}`)
    }
    break
  }
  for (const n of todo.nudge) {
    const rec = state.tasks[n.id]
    try {
      await choo.workspaces.message(rec.ws, n.message)
      rec.nudge = { sig: n.sig, count: (rec.nudge?.count ?? 0) + 1 }
    } catch {
      // Busy again, or gone: the next pass decides afresh.
    }
  }

  if (state.auto) {
    status = statuses(plan, state.tasks, workspaces)
    for (const t of plan.tasks) {
      const st = status[t.id]
      const rec = state.tasks[t.id]
      // Tell the person once about what only they can move.
      const tell = st === 'todo' ? 'todo' : (st === 'failing' || st === 'conflict') && (rec?.nudge?.count ?? 0) >= MAX_NUDGES && live.get(rec.ws)?.status === 'idle' ? 'stuck' : ''
      if (!tell || rec?.told === tell) continue
      record(t.id).told = tell
      if (tell === 'todo') notify(`Your turn: ${t.title}`, `${plan.title} is waiting for you to do this and tick it off.`)
      else notify(`${t.title} is stuck`, `Its agent tried ${MAX_NUDGES} times and the pull request still isn't clean.`, rec.ws)
    }
    if (todo.finished) {
      state.auto = false
      state.finishedAt = now
      notify(`${plan.title} is done`, `All ${plan.tasks.length} tasks are merged or ticked off.`)
    }
  }

  if (JSON.stringify(state) !== JSON.stringify(saved)) await choo.store.set(key, state)
}

/* ---- Tools for the orchestrator ---- */

async function repoFor(ctx, repoId) {
  const mine = ctx?.repoIds ?? []
  if (repoId) {
    if (!mine.includes(repoId)) throw new Error(`${repoId} isn't one of your projects (${mine.join(', ') || 'none'}).`)
    return repoId
  }
  if (mine.length === 1) return mine[0]
  const repos = await choo.repos.list()
  throw new Error(`Say which project with repo_id: ${repos.filter((r) => mine.includes(r.id)).map((r) => `${r.id} (${r.name})`).join(', ')}`)
}

async function open(ctx, input) {
  const repoId = await repoFor(ctx, input.repo_id)
  const file = await readPlan(repoId, String(input.name))
  if (!file) {
    const names = (await listPlans(repoId)).map((p) => p.name)
    throw new Error(`There is no plan called ${input.name}. ${names.length ? `Plans here: ${names.join(', ')}.` : 'This project has no plans yet: write one with plan_write.'}`)
  }
  return { repoId, ...file }
}

async function describe(repoId, file) {
  const state = await readState(repoId, file.name)
  const workspaces = await choo.workspaces.list({ repoId })
  const status = statuses(file.plan, state.tasks, workspaces)
  return { state, status, progress: summaryText(summary(file.plan, status)) }
}

export const tools = {
  plan_help: () => GUIDE,

  async plan_list(_input, ctx) {
    const out = []
    for (const repoId of ctx?.repoIds ?? []) {
      for (const p of await listPlans(repoId)) {
        const file = await readPlan(repoId, p.name)
        if (!file) continue
        const { state, progress } = await describe(repoId, file)
        out.push({ repo_id: repoId, name: p.name, title: file.plan.title, running: !!state.auto, progress, ...(file.plan.problems.length ? { problems: file.plan.problems.map((x) => x.message) } : {}) })
      }
    }
    return out.length ? out : 'No plans yet. Read plan_help, then write one with plan_write.'
  },

  async plan_read(input, ctx) {
    const file = await open(ctx, input)
    const { state, status, progress } = await describe(file.repoId, file)
    return {
      name: file.name,
      title: file.plan.title,
      running: !!state.auto,
      parallel: file.plan.parallel,
      progress,
      ...(file.plan.problems.length ? { problems: file.plan.problems.map((x) => `Line ${x.line}: ${x.message}`) } : {}),
      tasks: file.plan.tasks.map((t) => {
        const rec = state.tasks[t.id] ?? {}
        const waiting = waitingOn(file.plan, status, t)
        return {
          id: t.id,
          title: t.title,
          status: STATUS[status[t.id]].label,
          ...(waiting.length && !isDone(status[t.id]) ? { waiting_on: waiting } : {}),
          ...(rec.ws ? { workspace_id: rec.ws } : {}),
          ...(rec.pr ? { pull_request: rec.pr.url, failing_checks: rec.pr.checks.failed } : {}),
          ...(rec.error ? { error: rec.error } : {})
        }
      }),
      markdown: file.text
    }
  },

  async plan_write(input, ctx) {
    const repoId = await repoFor(ctx, input.repo_id)
    const name = String(input.name)
    const plan = parsePlan(input.markdown)
    if (plan.problems.length) throw new Error(`Not saved. Fix these and write it again:\n${plan.problems.map((p) => `- Line ${p.line}: ${p.message}`).join('\n')}`)
    await writePlan(repoId, name, String(input.markdown))
    const cols = columns(plan)
    return `Saved ${name}: ${plan.tasks.length} ${plan.tasks.length === 1 ? 'task' : 'tasks'} in ${cols.length} ${cols.length === 1 ? 'step' : 'steps'}, up to ${plan.parallel} at once. First to start: ${cols[0].join(', ')}. Nothing has started. The person can read it on the Plan board (Plans, under the project) and press Start ready, or you can call plan_start once they agree.`
  },

  async plan_start(input, ctx) {
    const file = await open(ctx, input)
    if (file.plan.problems.length) throw new Error(`This plan can't run yet:\n${file.plan.problems.map((p) => `- Line ${p.line}: ${p.message}`).join('\n')}`)
    await request(file.repoId, file.name, 'run')
    await tick()
    const { state, status, progress } = await describe(file.repoId, file)
    const started = file.plan.tasks.filter((t) => state.tasks[t.id]?.ws && ['running', 'approval', 'cloud'].includes(status[t.id])).map((t) => `${t.title} (workspace ${state.tasks[t.id].ws})`)
    const failed = file.plan.tasks.filter((t) => state.tasks[t.id]?.error).map((t) => `${t.title}: ${state.tasks[t.id].error}`)
    return [`${file.plan.title} is running. ${progress}.`, started.length ? `Working now: ${started.join('; ')}.` : 'Nothing is ready to start right now.', ...(failed.length ? [`Couldn't start: ${failed.join('; ')}.`] : []), 'The rest start by themselves as their dependencies merge.'].join(' ')
  },

  async plan_pause(input, ctx) {
    const file = await open(ctx, input)
    await request(file.repoId, file.name, 'pause')
    await tick()
    return `${file.plan.title} is paused: no more tasks will start. Agents already working carry on.`
  }
}

/** Wires the scheduler to the app. Called once by the background page. */
export function run() {
  let timer
  const soon = () => {
    clearTimeout(timer)
    timer = setTimeout(() => serial(() => tick()), 150)
  }
  choo.on('workspaces', soon)
  choo.on('prs', (e) => {
    prChanged.add(e.workspaceId)
    soon()
  })
  choo.on('store', (e) => {
    if (e.key === FILES_KEY || e.key.startsWith('req:')) soon()
  })
  setInterval(soon, 30_000)
  for (const [name, fn] of Object.entries(tools)) choo.tools.handle(name, (input, ctx) => serial(() => fn(input ?? {}, ctx)))
  soon()
}
