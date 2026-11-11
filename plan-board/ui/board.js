/** The Plans view under a project: the plan as a canvas of task cards, a panel for one task, and the plan as text. */
import { MAX_PARALLEL, NAME_RE, STATUS, columns, isDone, parsePlan, setSetting, slug, starterPlan, statuses, steps, summary, summaryText } from './plan.js'
import { FILES_KEY, deletePlan, listPlanTitles, listPlans, readPlan, readState, request, stateKey, writePlan } from './data.js'
import { debounce, h, metaLine, pill, taskDetail } from './ui.js'

const root = document.getElementById('app')
const app = {
  repoId: '',
  ready: false,
  plans: [],
  name: null,
  file: null,
  state: { auto: false, tasks: {} },
  workspaces: [],
  selected: null,
  /** board, edit (the plan as text) or new (naming a plan). */
  mode: 'board',
  draft: '',
  newTitle: '',
  confirmDelete: false,
  error: '',
  /** Task ids with a request on its way, so a pressed button doesn't sit there looking unpressed. */
  asked: new Set(),
  message: ''
}

const lastOpenKey = () => `open:${app.repoId}`

async function loadWorkspaces() {
  app.workspaces = await choo.workspaces.list({ repoId: app.repoId })
}

async function loadState() {
  app.state = app.name ? await readState(app.repoId, app.name) : { auto: false, tasks: {} }
  app.asked.clear()
}

async function loadFiles() {
  app.plans = await listPlanTitles(app.repoId)
  if (!app.plans.some((p) => p.name === app.name)) {
    const last = await choo.store.get(lastOpenKey())
    app.name = app.plans.find((p) => p.name === last)?.name ?? app.plans[0]?.name ?? null
    app.selected = null
  }
  app.file = app.name ? await readPlan(app.repoId, app.name) : null
  if (app.selected && !app.file?.plan.tasks.some((t) => t.id === app.selected)) app.selected = null
}

async function loadAll() {
  await Promise.all([loadFiles(), loadWorkspaces()])
  await loadState()
  app.ready = true
  render()
}

/** Run something the person asked for, and show what went wrong if it fails. */
async function act(fn) {
  app.error = ''
  try {
    await fn()
  } catch (e) {
    app.error = String(e?.message ?? e)
  }
  render()
}

const ask = (action, taskId, more) =>
  act(async () => {
    if (taskId) {
      app.asked.add(taskId)
      // A request that changes nothing (the task was no longer ready, say) gets no answer: give the buttons back.
      setTimeout(() => app.asked.delete(taskId) && render(), 8000)
    }
    await request(app.repoId, app.name, action, { ...(taskId ? { taskId } : {}), ...more })
  })

async function openPlan(name) {
  app.name = name
  app.selected = null
  app.mode = 'board'
  await choo.store.set(lastOpenKey(), name)
  await loadFiles()
  await loadState()
  render()
}

/* ---- Rendering ---- */

function render() {
  if (!app.ready) return
  // The editor keeps its own text and cursor: only the board is redrawn from scratch.
  const scroll = root.querySelector('.canvas')
  const at = scroll ? [scroll.scrollLeft, scroll.scrollTop] : null
  const typing = document.activeElement?.matches?.('.send textarea') ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null
  root.replaceChildren(...(app.mode === 'new' ? newPlan() : app.mode === 'edit' ? editor() : app.file ? board() : empty()).filter(Boolean))
  const canvas = root.querySelector('.canvas')
  if (canvas && at) [canvas.scrollLeft, canvas.scrollTop] = at
  if (typing) {
    const box = root.querySelector('.send textarea')
    box?.focus()
    box?.setSelectionRange(...typing)
  }
  drawLines()
}

function empty() {
  return [
    h(
      'div.empty',
      {},
      h('h2', {}, 'No plans in this project yet'),
      h('p', {}, 'A plan splits a big piece of work into tasks and draws what depends on what. Each task runs as its own agent, branch and pull request, and starts when the tasks it depends on are merged.'),
      h('button.primary', { onclick: () => ((app.mode = 'new'), (app.newTitle = ''), render()) }, 'New plan'),
      h('p.faint', {}, 'Or ask this project’s orchestrator: “Write a plan for …”. It shows up here.')
    )
  ]
}

function newPlan() {
  const create = () =>
    act(async () => {
      const name = slug(app.newTitle)
      if (!NAME_RE.test(name) || app.plans.some((p) => p.name === name)) return
      await writePlan(app.repoId, name, starterPlan(app.newTitle.trim()))
      app.name = name
      await choo.store.set(lastOpenKey(), name)
      await loadFiles()
      await loadState()
      app.draft = app.file.text
      app.mode = 'edit'
    })
  const input = h('input', { type: 'text', value: app.newTitle, placeholder: 'Billing v2', maxLength: 60, oninput: (e) => ((app.newTitle = e.target.value), refresh()), onkeydown: (e) => e.key === 'Enter' && create() })
  const hint = h('div.faint')
  const button = h('button.primary', { onclick: create }, 'Create plan')
  const refresh = () => {
    const n = slug(app.newTitle)
    const dup = app.plans.some((p) => p.name === n)
    hint.textContent = dup ? `There is already a plan called ${n}.` : n ? `Saved in the project as .choo-choo/plans/${n}.plan.md` : 'Give the plan a name.'
    hint.className = dup ? 'error' : 'faint'
    button.disabled = !n || dup
  }
  refresh()
  setTimeout(() => input.focus())
  return [
    h(
      'div.empty',
      {},
      h('h2', {}, 'New plan'),
      h('div.form', {}, h('label', { for: 'title' }, 'What is it for?'), Object.assign(input, { id: 'title' }), hint, app.error ? h('div.error', {}, app.error) : null),
      h('div.row', {}, h('button', { onclick: () => ((app.mode = 'board'), (app.error = ''), render()) }, 'Cancel'), button)
    )
  ]
}

function board() {
  const { plan } = app.file
  const status = statuses(plan, app.state.tasks, app.workspaces)
  const sum = summary(plan, status)
  const broken = plan.problems.length > 0
  const busy = plan.tasks.filter((t) => ['running', 'cloud', 'approval'].includes(status[t.id])).length
  const canStart = Math.max(0, Math.min(sum.ready, plan.parallel - busy))
  const allDone = sum.total > 0 && sum.done === sum.total
  const setParallel = (n) =>
    act(async () => {
      await writePlan(app.repoId, app.name, setSetting(app.file.text, 'parallel', n))
      await loadFiles()
    })

  const segments = [
    ['good', sum.done],
    ['busy', sum.working],
    ['you', sum.needsYou],
    ['bad', sum.failing],
    ['info', sum.review]
  ]
  const bar = h(
    'header.bar',
    {},
    app.plans.length > 1
      ? h('select', { title: 'Switch plan', onchange: (e) => openPlan(e.target.value) }, app.plans.map((p) => h('option', { value: p.name, selected: p.name === app.name }, p.title)))
      : h('h1', {}, plan.title),
    h('button.quiet', { title: 'Start another plan in this project', onclick: () => ((app.mode = 'new'), (app.newTitle = ''), (app.error = ''), render()) }, '+ New'),
    h(
      'div.progress.grow',
      {},
      h('div.track', {}, segments.filter(([, n]) => n).map(([tone, n]) => h('i', { data: { tone }, style: `width:${(100 * n) / sum.total}%` }))),
      h('div.text', {}, summaryText(sum))
    ),
    app.state.auto ? h('span.live', { title: 'Tasks start by themselves as the ones they depend on are merged.' }, h('i.pulse'), 'Running') : null,
    h(
      'span.stepper',
      { title: 'How many agents may work on this plan at the same time' },
      'Up to',
      h('button.icon', { disabled: plan.parallel <= 1 || broken, title: 'Fewer', onclick: () => setParallel(plan.parallel - 1) }, '−'),
      h('b', {}, String(plan.parallel)),
      h('button.icon', { disabled: plan.parallel >= MAX_PARALLEL || broken, title: 'More', onclick: () => setParallel(plan.parallel + 1) }, '+'),
      'at once'
    ),
    Object.keys(app.state.tasks).length ? h('button.quiet.icon', { title: 'Check the pull requests now', onclick: () => ask('refresh') }, '↻') : null,
    h('button', { onclick: () => ((app.draft = app.file.text), (app.mode = 'edit'), (app.confirmDelete = false), (app.error = ''), render()) }, 'Edit plan'),
    allDone
      ? null
      : app.state.auto
        ? h('button', { title: 'Stop starting new tasks. Agents already working carry on.', onclick: () => ask('pause') }, 'Pause')
        : h('button.primary', { disabled: broken, title: 'Start an agent for every ready task, and keep going as tasks merge.', onclick: () => ask('run') }, canStart ? `Start ready (${canStart})` : sum.done || Object.keys(app.state.tasks).length ? 'Resume' : 'Start')
  )

  const banner = broken
    ? h('div.banner', {}, h('b', {}, 'This plan can’t run yet.'), h('ul', {}, plan.problems.map((p) => h('li', {}, `Line ${p.line}: ${p.message}`))))
    : app.error
      ? h('div.banner', {}, app.error)
      : null

  const selected = plan.tasks.find((t) => t.id === app.selected)
  const near = selected ? new Set([selected.id, ...selected.depends, ...plan.tasks.filter((t) => t.depends.includes(selected.id)).map((t) => t.id)]) : null
  const cols = columns(plan)
  const graph = h(
    'div.graph',
    {},
    cols.map((ids, n) =>
      h(
        'div.step',
        {},
        h('header', {}, h('span', {}, `Step ${n + 1}`), h('span', {}, ids.length > 1 ? `${ids.length} side by side` : '')),
        ids.map((id) => card(plan, plan.tasks.find((t) => t.id === id), status, near))
      )
    )
  )
  const canvas = h('div.canvas', { onclick: (e) => e.target.closest('.card') || ((app.selected = null), render()) }, graph)
  return [bar, banner, h('div.body', {}, canvas, selected ? panel(plan, selected, status) : null)]
}

function card(plan, task, status, near) {
  const st = status[task.id]
  const rec = app.state.tasks[task.id]
  const ws = app.workspaces.find((w) => w.id === rec?.ws)
  const pick = () => ((app.selected = app.selected === task.id ? null : task.id), (app.message = ''), (app.error = ''), render())
  return h(
    `div.card${app.selected === task.id ? '.selected' : ''}${near && !near.has(task.id) ? '.dim' : ''}`,
    { data: { id: task.id, tone: STATUS[st].tone, status: st }, tabIndex: 0, role: 'button', onclick: pick, onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick()) },
    h('div.top', {}, pill(st), task.manual ? h('span.chip', {}, 'by hand') : task.model || plan.model ? h('span.chip', {}, task.model || plan.model) : null),
    h('div.title', {}, task.title),
    h('div.meta', {}, metaLine(plan, task, status, rec, ws))
  )
}

function panel(plan, task, status) {
  const st = status[task.id]
  const rec = app.state.tasks[task.id] ?? {}
  const ws = app.workspaces.find((w) => w.id === rec.ws)
  const asked = app.asked.has(task.id)
  const broken = plan.problems.length > 0
  const buttons = []
  if (task.manual) {
    if (st === 'todo' || st === 'waiting') buttons.push(h('button.primary', { disabled: asked, onclick: () => ask('done', task.id) }, 'Tick it off'))
    else buttons.push(h('button', { disabled: asked, onclick: () => ask('undone', task.id) }, 'Untick'))
  } else {
    if (st === 'ready' || (st === 'error' && !rec.ws)) buttons.push(h('button.primary', { disabled: asked || broken, onclick: () => ask('start', task.id) }, asked ? 'Starting…' : st === 'error' ? 'Try again' : 'Start'))
    if (st === 'waiting') buttons.push(h('button', { disabled: asked || broken, title: 'Start now, without what it depends on', onclick: () => ask('start', task.id, { force: true }) }, asked ? 'Starting…' : 'Start anyway'))
    if (ws) buttons.push(h('button.primary', { title: 'Opens beside the board when Choo Choo has split panes', onclick: () => act(() => choo.ui.openWorkspace(ws.id, { beside: true })) }, 'Open workspace'))
    if (ws && (st === 'running' || st === 'approval')) buttons.push(h('button', { onclick: () => act(() => choo.workspaces.stop(ws.id)) }, 'Stop'))
    if (st === 'gone') buttons.push(h('button.primary', { disabled: asked || broken, onclick: () => ask('start', task.id) }, asked ? 'Starting…' : 'Start again'))
    if (st === 'done') buttons.push(h('button', { disabled: asked, onclick: () => ask('undone', task.id) }, 'Not done after all'))
    else if (st !== 'merged') buttons.push(h('button.quiet', { disabled: asked, title: 'Count this task as done without a merged pull request, for example when you did it yourself.', onclick: () => ask('done', task.id) }, 'Mark done'))
    if (rec.ws && st !== 'merged' && st !== 'running') buttons.push(h('button.quiet', { disabled: asked, title: 'Unlink the workspace from this task, so the task can start again. The workspace itself stays.', onclick: () => ask('reset', task.id) }, 'Forget workspace'))
  }

  const pr = rec.pr
  const send = () =>
    act(async () => {
      await choo.workspaces.message(ws.id, app.message.trim())
      app.message = ''
    })
  return h(
    'aside.panel',
    {},
    h('div.row', {}, pill(st), task.manual ? h('span.chip', {}, 'by hand') : null, h('span.grow'), h('button.quiet.icon', { title: 'Close', onclick: () => ((app.selected = null), render()) }, '✕')),
    h('h2', {}, task.title),
    h('div.muted', {}, metaLine(plan, task, status, rec, ws)),
    h('div.actions', {}, buttons),
    app.error ? h('div.note.bad.error', {}, app.error) : null,
    st === 'error' && rec.error ? h('div.note.bad', {}, rec.error) : null,
    pr?.checks.failed.length && st !== 'merged'
      ? h('div.note.bad', {}, h('h3', {}, 'Failing checks'), h('ul.checks', {}, pr.checks.failed.map((c) => h('li', {}, c))), rec.nudge ? h('div.muted', {}, `The agent was asked to fix this ${rec.nudge.count === 1 ? 'once' : `${rec.nudge.count} times`}.`) : null)
      : null,
    ws?.lastMessage ? h('section', {}, h('h3', {}, 'Latest from the agent'), h('pre.said', {}, ws.lastMessage)) : null,
    ws && !['running', 'cloud', 'merged', 'done'].includes(st)
      ? h(
          'section.send',
          {},
          h('h3', {}, 'Message the agent'),
          h('textarea', { value: app.message, placeholder: 'What should it do next?', oninput: (e) => ((app.message = e.target.value), (sendButton.disabled = !app.message.trim())) }),
          h('div.row', {}, h('span.grow'), sendButtonFor(send))
        )
      : null,
    taskDetail(plan, task, status, (id) => ((app.selected = id), (app.message = ''), render()))
  )
}

let sendButton
function sendButtonFor(send) {
  sendButton = h('button', { disabled: !app.message.trim(), onclick: send }, 'Send')
  return sendButton
}

/** Lines from each task to the tasks that depend on it, drawn under the cards. */
function drawLines() {
  const graph = root.querySelector('.graph')
  if (!graph || !app.file) return
  graph.querySelector('svg')?.remove()
  const { plan } = app.file
  const status = statuses(plan, app.state.tasks, app.workspaces)
  const box = new Map([...graph.querySelectorAll('.card')].map((el) => [el.dataset.id, el]))
  const step = steps(plan)
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('width', graph.scrollWidth)
  svg.setAttribute('height', graph.scrollHeight)
  const origin = graph.getBoundingClientRect()
  const paths = []
  for (const t of plan.tasks) {
    const to = box.get(t.id)
    for (const d of t.depends) {
      const from = box.get(d)
      if (!from || !to || d === t.id) continue
      const a = from.getBoundingClientRect()
      const b = to.getBoundingClientRect()
      const x1 = a.right - origin.left
      const y1 = a.top + a.height / 2 - origin.top
      const x2 = b.left - origin.left
      const y2 = b.top + b.height / 2 - origin.top
      const bend = Math.max(26, (x2 - x1) / 2)
      const path = document.createElementNS(NS, 'path')
      path.setAttribute('d', `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`)
      const on = app.selected && (app.selected === t.id || app.selected === d)
      // A line that skips a step runs under the cards in between, so it is drawn fainter.
      const far = step.get(t.id) - step.get(d) > 1
      path.setAttribute('class', [isDone(status[d]) ? 'done' : '', on ? 'on' : app.selected ? 'dim' : far ? 'far' : ''].join(' ').trim())
      paths.push([on ? 1 : 0, path])
    }
  }
  // Highlighted lines go on top.
  for (const [, p] of paths.sort((a, b) => a[0] - b[0])) svg.append(p)
  graph.prepend(svg)
}

function editor() {
  const problems = h('div')
  const check = () => {
    const found = parsePlan(app.draft)
    problems.replaceChildren(
      found.problems.length
        ? h('div', {}, h('h3', {}, 'To fix before it can run'), h('ul.error', {}, found.problems.map((p) => h('li', {}, `Line ${p.line}: ${p.message}`))))
        : h('div.muted', {}, `${found.tasks.length} ${found.tasks.length === 1 ? 'task' : 'tasks'} in ${columns(found).length} ${columns(found).length === 1 ? 'step' : 'steps'}. Looks good.`)
    )
  }
  check()
  const save = () =>
    act(async () => {
      await writePlan(app.repoId, app.name, app.draft)
      await loadFiles()
      app.mode = 'board'
    })
  const remove = () =>
    act(async () => {
      await deletePlan(app.repoId, app.name)
      app.name = null
      app.mode = 'board'
      await loadFiles()
      await loadState()
    })
  const text = h('textarea', { value: app.draft, spellcheck: false, oninput: (e) => ((app.draft = e.target.value), check()), onkeydown: (e) => (e.metaKey || e.ctrlKey) && e.key === 's' && (e.preventDefault(), save()) })
  setTimeout(() => text.focus())
  return [
    h(
      'header.bar',
      {},
      h('h1', {}, app.file?.plan.title ?? app.name),
      h('span.faint.mono.grow', {}, `.choo-choo/plans/${app.name}.plan.md`),
      h('button', { onclick: () => ((app.mode = 'board'), (app.error = ''), render()) }, 'Cancel'),
      h('button.primary', { onclick: save }, 'Save')
    ),
    app.error ? h('div.banner', {}, app.error) : null,
    h(
      'div.editor',
      {},
      text,
      h(
        'aside',
        {},
        problems,
        h(
          'div',
          {},
          h('h3', {}, 'How a plan is written'),
          h('pre', {}, 'Each “## Title” is a task: one agent, one branch, one pull request.\n\nRight under the title:\n- id: short-name\n- depends on: other-id, another-id\n- model: opus\n- manual: yes   (you do it and tick it off)\n\nThen the brief, and a “### Done when” list.\n\nText above the first task goes to every agent.')
        ),
        h(
          'div',
          {},
          app.confirmDelete
            ? h('div.note.bad', {}, h('div', {}, 'Delete this plan’s file? Its workspaces and pull requests stay.'), h('div.row', { style: 'margin-top:8px' }, h('button', { onclick: () => ((app.confirmDelete = false), render()) }, 'Keep it'), h('button.danger', { onclick: remove }, 'Delete plan')))
            : h('button.quiet.danger', { onclick: () => ((app.confirmDelete = true), render()) }, 'Delete plan…')
        )
      )
    )
  ]
}

/* ---- Keeping up with the app ---- */

choo.ready.then(async () => {
  app.repoId = choo.context.repoId
  if (!app.repoId) {
    root.replaceChildren(h('div.empty', {}, h('p', {}, 'Plans belong to a project. Open this view from under a project in the sidebar.')))
    return
  }
  try {
    await loadAll()
  } catch (e) {
    root.replaceChildren(h('div.empty', {}, h('p.error', {}, String(e?.message ?? e))))
    return
  }
  const quiet = () => app.mode === 'board'
  const workspacesChanged = debounce(() => loadWorkspaces().then(() => quiet() && render()), 150)
  const filesChanged = debounce(() => quiet() && loadFiles().then(render), 150)
  choo.on('workspaces', workspacesChanged)
  choo.on('store', (e) => {
    if (e.key === FILES_KEY) filesChanged()
    else if (app.name && e.key === stateKey(app.repoId, app.name)) loadState().then(() => quiet() && render())
  })
  // Someone may edit the plan file in their editor, or pull a coworker's change.
  setInterval(async () => {
    if (!quiet() || !app.name) return
    const plans = await listPlans(app.repoId).catch(() => null)
    if (!plans) return
    const mine = plans.find((p) => p.name === app.name)
    if (plans.length !== app.plans.length || mine?.modified !== app.file?.modified) filesChanged()
  }, 8000)
  new ResizeObserver(debounce(drawLines, 50)).observe(root)
})
