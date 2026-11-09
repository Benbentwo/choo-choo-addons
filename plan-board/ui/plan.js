/**
 * Everything about a plan that needs no app: reading the plan file, laying tasks out in steps,
 * working out each task's status, and deciding what to start next. No DOM and no `choo` in here,
 * so the views, the background page and the tests (plain Node) all use the same code.
 */

export const MODELS = ['opus', 'fable', 'sonnet', 'haiku', 'codex']
export const DEFAULT_PARALLEL = 3
/** Choo Choo lets one add-on run at most 8 agents at once. */
export const MAX_PARALLEL = 8
/** After this many "please fix it" messages on one task, the plan leaves it to the person. */
export const MAX_NUDGES = 3
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

export const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '')

const META = {
  id: 'id',
  'depends on': 'depends',
  depends: 'depends',
  after: 'depends',
  needs: 'depends',
  'blocked by': 'depends',
  model: 'model',
  manual: 'manual'
}
const DONE_WHEN = /^(done when|acceptance( criteria)?|definition of done)\s*:?$/i
const YES = /^(yes|true|y|1)$/i

/**
 * Reads a plan file. Always returns a plan; `problems` lists what must be fixed before it can run.
 *
 *   ---
 *   title: Billing v2
 *   parallel: 3
 *   ---
 *   What every agent should know.
 *
 *   ## Invoice model
 *   - id: invoice-model
 *   - depends on: schema
 *   - model: opus
 *
 *   The brief.
 *
 *   ### Done when
 *   - Tests pass
 */
export function parsePlan(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const plan = { title: '', parallel: DEFAULT_PARALLEL, model: '', context: '', tasks: [], problems: [] }
  const problem = (line, message) => plan.problems.push({ line: line + 1, message })
  let i = 0

  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, n) => n > 0 && l.trim() === '---')
    if (end < 0) problem(0, 'The settings at the top start with --- but never close. Add a second --- line.')
    else {
      for (let n = 1; n < end; n++) {
        const m = /^([A-Za-z][\w -]*?)\s*:\s*(.*)$/.exec(lines[n])
        if (!m) continue
        const key = m[1].toLowerCase()
        const value = m[2].trim().replace(/^(["'])(.*)\1$/, '$2')
        if (key === 'title') plan.title = value
        else if (key === 'model') {
          if (value && !MODELS.includes(value)) problem(n, `Model "${value}" isn't one of ${MODELS.join(', ')}.`)
          else plan.model = value
        } else if (key === 'parallel') {
          const count = Number(value)
          if (!Number.isInteger(count) || count < 1 || count > MAX_PARALLEL) problem(n, `parallel must be a whole number from 1 to ${MAX_PARALLEL}.`)
          else plan.parallel = count
        }
      }
      i = end + 1
    }
  }

  const context = []
  let task = null
  let part = 'context'
  let fence = null
  const closeTask = () => {
    if (!task) return
    task.brief = trimBlank(task.briefLines).join('\n')
    delete task.briefLines
  }

  for (; i < lines.length; i++) {
    const line = lines[i]
    const fenced = /^\s*(```+|~~~+)/.exec(line)
    if (fenced) {
      if (!fence) fence = fenced[1][0]
      else if (fenced[1][0] === fence) fence = null
    }
    const heading = !fence && !fenced ? /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line) : null

    if (heading && heading[1].length === 2) {
      closeTask()
      task = { id: '', title: heading[2], depends: [], model: '', manual: false, briefLines: [], doneWhen: [], line: i + 1 }
      plan.tasks.push(task)
      // The lines right under the heading that set the task up.
      let n = i + 1
      while (n < lines.length && !lines[n].trim()) n++
      for (; n < lines.length; n++) {
        const m = /^\s*(?:[-*]\s+)?([A-Za-z][A-Za-z ]*?)\s*:\s*(.*)$/.exec(lines[n])
        const key = m && META[m[1].toLowerCase()]
        if (!key) break
        const value = m[2].trim()
        if (key === 'id') {
          task.id = value
          if (!ID_RE.test(value)) problem(n, `"${value}" can't be a task id. Use lowercase letters, digits and dashes, at most 32 characters.`)
        } else if (key === 'depends') {
          task.depends = /^(none|nothing|-)?$/i.test(value) ? [] : [...new Set(value.split(',').map((d) => d.trim()).filter(Boolean))]
        } else if (key === 'model') {
          if (value && !MODELS.includes(value)) problem(n, `Model "${value}" isn't one of ${MODELS.join(', ')}.`)
          else task.model = value
        } else if (key === 'manual') task.manual = YES.test(value)
        i = n
      }
      if (!task.id) {
        task.id = slug(task.title)
        if (!task.id) problem(task.line - 1, `Give "${task.title}" an id line, for example "- id: task-${plan.tasks.length}".`)
      }
      part = 'brief'
      continue
    }

    if (!task) {
      if (heading && heading[1].length === 1 && !plan.title) plan.title = heading[2]
      else if (!(heading && heading[1].length === 1)) context.push(line)
      continue
    }
    if (heading && heading[1].length === 3 && DONE_WHEN.test(heading[2])) {
      part = 'done'
      continue
    }
    if (heading) part = 'brief'
    if (part === 'done') {
      const item = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line)
      if (item) task.doneWhen.push(item[1].trim())
      // A wrapped line belongs to the item above it.
      else if (line.trim() && task.doneWhen.length) task.doneWhen[task.doneWhen.length - 1] += ` ${line.trim()}`
      else if (line.trim()) task.briefLines.push(line)
      continue
    }
    task.briefLines.push(line)
  }
  closeTask()
  plan.context = trimBlank(context).join('\n')

  if (!plan.tasks.length) problem(0, 'There are no tasks yet. Each task is a section that starts with "## Its title".')
  const seen = new Map()
  for (const t of plan.tasks) {
    if (!t.id) continue
    if (seen.has(t.id)) problem(t.line - 1, `Two tasks have the id "${t.id}" ("${seen.get(t.id).title}" and "${t.title}"). Give one of them its own "- id:" line.`)
    else seen.set(t.id, t)
  }
  for (const t of plan.tasks) {
    for (const d of t.depends) {
      if (d === t.id) problem(t.line - 1, `"${t.title}" depends on itself.`)
      else if (!seen.has(d)) problem(t.line - 1, `"${t.title}" depends on "${d}", which isn't a task id in this plan.`)
    }
  }
  const loop = findLoop(plan.tasks, seen)
  if (loop) problem(seen.get(loop[0]).line - 1, `These tasks wait on each other in a circle: ${loop.join(' → ')} → ${loop[0]}. Remove one of the "depends on" links.`)
  return plan
}

function trimBlank(lines) {
  let a = 0
  let b = lines.length
  while (a < b && !lines[a].trim()) a++
  while (b > a && !lines[b - 1].trim()) b--
  return lines.slice(a, b)
}

function findLoop(tasks, byId) {
  const state = new Map()
  const path = []
  const visit = (id) => {
    if (state.get(id) === 2) return null
    if (state.get(id) === 1) return path.slice(path.indexOf(id))
    state.set(id, 1)
    path.push(id)
    for (const d of byId.get(id)?.depends ?? []) {
      if (!byId.has(d) || d === id) continue
      const loop = visit(d)
      if (loop) return loop
    }
    path.pop()
    state.set(id, 2)
    return null
  }
  for (const t of tasks) {
    const loop = t.id && byId.get(t.id) === t ? visit(t.id) : null
    if (loop) return loop
  }
  return null
}

/** Changes one setting at the top of a plan file and leaves the rest of the text alone. */
export function setSetting(text, key, value) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  const entry = `${key}: ${value}`
  if (lines[0]?.trim() !== '---') return [`---`, entry, `---`, '', ...lines].join('\n')
  const end = lines.findIndex((l, n) => n > 0 && l.trim() === '---')
  if (end < 0) return text
  const at = lines.findIndex((l, n) => n > 0 && n < end && new RegExp(`^${key}\\s*:`, 'i').test(l))
  if (at >= 0) lines[at] = entry
  else lines.splice(end, 0, entry)
  return lines.join('\n')
}

/** A plan to start from. */
export function starterPlan(title) {
  return `---
title: ${title}
parallel: ${DEFAULT_PARALLEL}
---

What every agent working on this plan should know: the goal, the conventions to follow, where the spec is.

## First task
- id: first-task

What to build, in enough detail for an agent that has seen nothing else. One task is one agent, one branch and one pull request.

### Done when
- The tests pass
- A pull request is open

## Second task
- id: second-task
- depends on: first-task

This one starts when the first task's pull request is merged.

## Check it on staging
- id: check-staging
- depends on: second-task
- manual: yes

Something a person does. You tick it off on the board.
`
}

/**
 * Which step each task is in: 0 when it depends on nothing, otherwise one past its latest
 * dependency. Unknown dependencies and loops are ignored, so a broken plan still draws.
 */
export function steps(plan) {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]))
  const step = new Map()
  const visiting = new Set()
  const of = (id) => {
    if (step.has(id)) return step.get(id)
    if (visiting.has(id)) return 0
    visiting.add(id)
    let n = 0
    for (const d of byId.get(id).depends) if (byId.has(d) && d !== id) n = Math.max(n, of(d) + 1)
    visiting.delete(id)
    step.set(id, n)
    return n
  }
  for (const t of byId.values()) of(t.id)
  return step
}

/** Task ids by step, each column ordered so tasks sit near what they depend on. */
export function columns(plan) {
  const step = steps(plan)
  const cols = []
  for (const t of plan.tasks) {
    if (!step.has(t.id)) continue
    ;(cols[step.get(t.id)] ??= []).push(t)
  }
  const row = new Map()
  const out = []
  cols.forEach((col, c) => {
    const weight = (t) => {
      const rows = t.depends.filter((d) => row.has(d)).map((d) => row.get(d))
      return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : Infinity
    }
    const sorted = c === 0 ? col : col.map((t, n) => ({ t, n, w: weight(t) })).sort((a, b) => (a.w === b.w ? a.n - b.n : a.w - b.w)).map((x) => x.t)
    sorted.forEach((t, n) => row.set(t.id, n))
    out.push(sorted.map((t) => t.id))
  })
  return out
}

/** How each status reads on a card, and which color family it gets. */
export const STATUS = {
  merged: { label: 'Merged', tone: 'good' },
  done: { label: 'Done', tone: 'good' },
  running: { label: 'Running', tone: 'busy' },
  cloud: { label: 'In the cloud', tone: 'busy' },
  approval: { label: 'Needs approval', tone: 'you' },
  stopped: { label: 'Stopped, no pull request', tone: 'you' },
  todo: { label: 'You do this', tone: 'you' },
  error: { label: 'Error', tone: 'bad' },
  failing: { label: 'Checks failing', tone: 'bad' },
  conflict: { label: 'Has conflicts', tone: 'bad' },
  closed: { label: 'Pull request closed', tone: 'bad' },
  checking: { label: 'Checks running', tone: 'info' },
  draft: { label: 'Draft pull request', tone: 'info' },
  review: { label: 'In review', tone: 'info' },
  gone: { label: 'Workspace archived', tone: 'quiet' },
  ready: { label: 'Ready', tone: 'ready' },
  waiting: { label: 'Waiting', tone: 'quiet' }
}

const DONE = new Set(['merged', 'done'])
/** An agent is at work, or stuck on a question only the person can answer: it holds one of the plan's places. */
const BUSY = new Set(['running', 'cloud', 'approval'])
const NEEDS_YOU = new Set(['approval', 'stopped', 'todo', 'error', 'closed', 'gone'])

export const isDone = (status) => DONE.has(status)
export const needsYou = (status) => NEEDS_YOU.has(status)

/**
 * The status of every task. `records` is what the plan remembers per task id (its workspace, its
 * pull request, when it merged); `workspaces` is the app's live list.
 */
export function statuses(plan, records = {}, workspaces = []) {
  const live = new Map(workspaces.map((w) => [w.id, w]))
  const own = (t) => {
    const r = records[t.id] ?? {}
    if (r.mergedAt || r.pr?.state === 'MERGED') return 'merged'
    if (r.doneAt) return 'done'
    if (!r.ws) return r.error ? 'error' : null
    const ws = live.get(r.ws)
    if (!ws) return 'gone'
    if (ws.status === 'needs-approval') return 'approval'
    if (ws.status === 'running') return 'running'
    if (ws.status === 'in-cloud') return 'cloud'
    if (ws.status === 'error') return 'error'
    const pr = r.pr
    if (!pr) return 'stopped'
    if (pr.state === 'CLOSED') return 'closed'
    if (pr.mergeState === 'DIRTY') return 'conflict'
    if (pr.checks?.failed?.length) return 'failing'
    if (pr.checks?.pending) return 'checking'
    return pr.isDraft ? 'draft' : 'review'
  }
  const out = {}
  for (const t of plan.tasks) out[t.id] = own(t)
  const done = (id) => DONE.has(out[id])
  for (const t of plan.tasks) {
    if (out[t.id]) continue
    const open = t.depends.every((d) => !(d in out) || done(d))
    out[t.id] = !open ? 'waiting' : t.manual ? 'todo' : 'ready'
  }
  return out
}

/** The dependencies a task is still waiting on. */
export function waitingOn(plan, status, task) {
  return task.depends.filter((d) => d in status && !DONE.has(status[d]))
}

/** The tasks that list this one in "depends on". */
export function unblocks(plan, task) {
  return plan.tasks.filter((t) => t.depends.includes(task.id))
}

export function summary(plan, status) {
  const s = { total: plan.tasks.length, done: 0, working: 0, needsYou: 0, failing: 0, review: 0, ready: 0, waiting: 0 }
  for (const t of plan.tasks) {
    const st = status[t.id]
    if (DONE.has(st)) s.done++
    else if (st === 'running' || st === 'cloud') s.working++
    else if (NEEDS_YOU.has(st)) s.needsYou++
    else if (st === 'failing' || st === 'conflict') s.failing++
    else if (st === 'checking' || st === 'draft' || st === 'review') s.review++
    else if (st === 'ready') s.ready++
    else s.waiting++
  }
  return s
}

/** "3 of 9 merged · 1 running · 1 needs you" */
export function summaryText(s) {
  const parts = [`${s.done} of ${s.total} done`]
  if (s.working) parts.push(`${s.working} running`)
  if (s.needsYou) parts.push(`${s.needsYou} ${s.needsYou === 1 ? 'needs' : 'need'} you`)
  if (s.failing) parts.push(`${s.failing} failing`)
  if (s.review) parts.push(`${s.review} in review`)
  if (s.ready) parts.push(`${s.ready} ready`)
  return parts.join(' · ')
}

/**
 * What the plan should do now. Pure: the background page carries it out.
 *   start: tasks to start, in file order, as far as the parallel limit allows
 *   nudge: idle agents to message about failing checks or conflicts, once per problem
 *   finished: every task is done
 */
export function decide(plan, state, status) {
  const out = { start: [], nudge: [], finished: plan.tasks.length > 0 && plan.tasks.every((t) => DONE.has(status[t.id])) }
  if (!state?.auto || plan.problems.length) return out
  let busy = plan.tasks.filter((t) => BUSY.has(status[t.id])).length
  for (const t of plan.tasks) {
    if (busy >= plan.parallel) break
    if (status[t.id] !== 'ready') continue
    out.start.push(t.id)
    busy++
  }
  for (const t of plan.tasks) {
    const r = state.tasks?.[t.id]
    const st = status[t.id]
    if (!r?.ws || (st !== 'failing' && st !== 'conflict')) continue
    const sig = st === 'conflict' ? 'conflict' : `checks:${[...r.pr.checks.failed].sort().join('|')}`
    if (r.nudge?.sig === sig || (r.nudge?.count ?? 0) >= MAX_NUDGES) continue
    out.nudge.push({ id: t.id, sig, message: st === 'conflict' ? CONFLICT_MESSAGE : failingMessage(r.pr.checks.failed) })
  }
  return out
}

const CONFLICT_MESSAGE = "Your pull request has conflicts with the base branch, because other tasks in the plan merged first. Merge the base branch into yours, resolve the conflicts so both changes keep working, run the tests and push."

function failingMessage(failed) {
  return `These checks are failing on your pull request: ${failed.join(', ')}. Read their logs, fix what they report and push. If a failure has nothing to do with your change, say so instead of working around it.`
}

/** What a task's agent is told when it starts. */
export function taskPrompt(plan, task) {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]))
  const before = task.depends.map((d) => byId.get(d)?.title).filter(Boolean)
  const others = plan.tasks.filter((t) => t.id !== task.id && !task.depends.includes(t.id)).map((t) => t.title)
  return [
    `You are doing one task of a larger plan${plan.title ? `, "${plan.title}"` : ''}. Other agents are doing the other tasks in their own branches, so stay inside this one.`,
    '',
    `## Your task: ${task.title}`,
    '',
    task.brief || '(No brief was written. Work from the title and the plan notes below, and say what you assumed.)',
    ...(task.doneWhen.length ? ['', '## Done when', '', ...task.doneWhen.map((d) => `- ${d}`)] : []),
    ...(plan.context ? ['', '## About the plan', '', plan.context] : []),
    ...(before.length ? ['', '## Already merged', '', 'These tasks were finished and merged before you started, and your branch has them:', ...before.map((b) => `- ${b}`)] : []),
    ...(others.length ? ['', '## Not yours', '', "Other tasks in the plan. Don't do their work, and expect their changes to land around yours:", ...others.map((b) => `- ${b}`)] : []),
    '',
    'When the work is done and you have checked it, commit, push your branch and open a pull request whose description says what changed and how you tested it. The plan moves on when that pull request is merged. If something outside your task blocks you, stop and say what it is.'
  ].join('\n')
}

/** What plan_help tells the orchestrator. */
export const GUIDE = `A plan is a Markdown file. Each "## " section is one task: one agent, one branch, one pull request.

---
title: Billing v2
parallel: 3
---

What every agent should know: the goal, conventions, where the spec is. Every task's agent gets this.

## Invoice model
- id: invoice-model
- model: opus

The brief: what to build, in enough detail for an agent that has seen nothing else.

### Done when
- Migration and model exist, with tests

## Invoice API
- id: invoice-api
- depends on: invoice-model

## Check staging
- id: check-staging
- depends on: invoice-api
- manual: yes

Rules:
- The lines right under a heading set the task up. "id" is lowercase letters, digits and dashes. "depends on" lists task ids, separated by commas. "model" is one of ${MODELS.join(', ')} and is optional. "manual: yes" is a step a person does and ticks off.
- "parallel" at the top is how many agents may work at once (1 to ${MAX_PARALLEL}, default ${DEFAULT_PARALLEL}).
- A task starts when everything it depends on is merged, and it starts from the updated default branch, so later tasks see earlier ones' code.

Splitting work:
- Make each task small enough to review as one pull request, and complete enough to merge on its own without breaking the build.
- Add "depends on" only where a task needs another's code. Tasks with no link between them run side by side, so fewer links means a faster plan.
- Two tasks that would edit the same files should be one task, or one should depend on the other. Agents working side by side can't see each other's changes.
- Put shared groundwork (schema, types, an interface) in an early task that others depend on.
- Write each brief for someone with no context: name files, endpoints and behavior. Put what applies to every task in the text above the first task.
- Give every task a "Done when" list an agent can check itself against.
`
