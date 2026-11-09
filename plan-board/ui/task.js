/** The Plan tab beside a workspace: which task of which plan this workspace is doing, and what is around it. */
import { statuses, summary, summaryText } from './plan.js'
import { FILES_KEY, parseStateKey, readPlan, readState } from './data.js'
import { debounce, h, metaLine, pill, taskDetail } from './ui.js'

const root = document.getElementById('app')

/** The plan and task this workspace belongs to, or null. */
async function find(repoId, workspaceId) {
  for (const key of await choo.store.keys()) {
    const at = parseStateKey(key)
    if (!at || at.repoId !== repoId) continue
    const state = await readState(repoId, at.name)
    const taskId = Object.keys(state.tasks).find((id) => state.tasks[id].ws === workspaceId)
    if (!taskId) continue
    const file = await readPlan(repoId, at.name)
    const task = file?.plan.tasks.find((t) => t.id === taskId)
    if (task) return { file, state, task }
  }
  return null
}

async function render() {
  const { repoId, workspaceId } = choo.context
  const found = await find(repoId, workspaceId)
  if (!found) {
    root.replaceChildren(
      h('div.empty', {}, h('h2', {}, 'Not part of a plan'), h('p', {}, 'Workspaces that a plan starts show their task here: the brief, what it waits on and what it unblocks. Plans are under the project in the sidebar.'))
    )
    return
  }
  const { file, state, task } = found
  const workspaces = await choo.workspaces.list({ repoId })
  const status = statuses(file.plan, state.tasks, workspaces)
  const rec = state.tasks[task.id]
  root.replaceChildren(
    h(
      'div.tab',
      {},
      h('div.plan', {}, h('div.faint', {}, 'Plan'), h('b', {}, file.plan.title), h('div.muted', {}, summaryText(summary(file.plan, status)))),
      h('div.row', {}, pill(status[task.id])),
      h('h2', {}, task.title),
      h('div.muted', {}, metaLine(file.plan, task, status, rec, workspaces.find((w) => w.id === workspaceId))),
      taskDetail(file.plan, task, status, null)
    )
  )
}

choo.ready.then(() => {
  const again = debounce(() => render().catch((e) => root.replaceChildren(h('div.empty', {}, h('p.error', {}, String(e?.message ?? e))))), 150)
  again()
  choo.on('workspaces', again)
  choo.on('store', (e) => (e.key === FILES_KEY || e.key.startsWith('state:')) && again())
})
