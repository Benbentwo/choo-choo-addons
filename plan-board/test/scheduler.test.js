import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { forget, prChangedFor, tick, tools } from '../ui/scheduler.js'
import { planPath, request, stateKey } from '../ui/data.js'

/** The slice of the app the scheduler talks to. */
function fakeApp() {
  const app = {
    store: new Map(),
    files: new Map(),
    workspaces: [],
    prs: new Map(),
    started: [],
    messages: [],
    notes: [],
    failStart: null
  }
  globalThis.choo = {
    store: {
      keys: async () => [...app.store.keys()],
      get: async (k) => (app.store.has(k) ? structuredClone(app.store.get(k)) : null),
      set: async (k, v) => void app.store.set(k, structuredClone(v)),
      delete: async (k) => void app.store.delete(k)
    },
    files: {
      list: async (_repo, dir) => [...app.files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((path) => ({ path, size: 1, modified: 1 })),
      read: async (_repo, path) => (app.files.has(path) ? { content: app.files.get(path), modified: 1 } : null),
      write: async (_repo, path, content) => void app.files.set(path, content),
      delete: async (_repo, path) => void app.files.delete(path)
    },
    repos: { list: async () => [{ id: 'r1', name: 'shop' }, { id: 'r2', name: 'docs' }] },
    workspaces: {
      list: async ({ repoId }) => app.workspaces.filter((w) => w.repoId === repoId).map((w) => ({ ...w })),
      start: async (opts) => {
        if (app.failStart) throw new Error(app.failStart)
        const ws = { id: `w${app.workspaces.length + 1}`, repoId: opts.repoId, title: opts.title, branch: `b/${app.workspaces.length + 1}`, status: 'running' }
        app.workspaces.push(ws)
        app.started.push(opts)
        return { ...ws }
      },
      message: async (id, message) => {
        if (app.workspaces.find((w) => w.id === id).status === 'running') throw new Error('still running')
        app.messages.push({ id, message })
      }
    },
    prs: { status: async (id) => app.prs.get(id) ?? { pr: null, checks: { total: 0, passed: 0, pending: 0, failed: [] } } },
    ui: { notify: async (title, body, workspaceId) => void app.notes.push({ title, body, workspaceId }) }
  }
  return app
}

const PLAN = `---
title: Shop
parallel: 2
---
Use pnpm.

## A
## B
- model: opus
## C
## D
- depends on: a
## Ship it
- id: ship
- depends on: b, c, d
- manual: yes
`
const pr = (state, failed = []) => ({ pr: { number: 1, url: 'https://x/pull/1', state, isDraft: false, reviewDecision: '', mergeState: 'CLEAN' }, checks: { total: 1, passed: failed.length ? 0 : 1, pending: 0, failed: failed.map((name) => ({ name, link: '' })) } })

let app
let now
const pass = () => tick((now += 5 * 60_000))
const state = () => app.store.get(stateKey('r1', 'shop'))
const finish = (id, result) => {
  app.workspaces.find((w) => w.id === id).status = 'idle'
  app.prs.set(id, result)
}

beforeEach(() => {
  app = fakeApp()
  forget()
  now = 1_000_000
  app.files.set(planPath('shop'), PLAN)
})

test('runs a plan from the first start to the last tick', async () => {
  await pass()
  assert.equal(state(), undefined, 'a plan nobody started keeps no state')

  await request('r1', 'shop', 'run')
  await pass()
  assert.deepEqual([...app.store.keys()], [stateKey('r1', 'shop')], 'the request is used up')
  assert.equal(state().auto, true)
  assert.deepEqual(app.started.map((s) => [s.title, s.model]), [['A', undefined], ['B', 'opus']])
  assert.match(app.started[0].task, /## Your task: A[\s\S]*Use pnpm\./)
  assert.deepEqual(state().tasks.a, { ws: 'w1', branch: 'b/1', startedAt: now })

  await pass()
  assert.equal(app.started.length, 2, 'two at once is the limit')

  // A opens a pull request: its place is free, so C starts. D still waits for A to merge.
  finish('w1', pr('OPEN'))
  await pass()
  assert.deepEqual(app.started.map((s) => s.title), ['A', 'B', 'C'])
  assert.equal(state().tasks.a.pr.number, 1)

  finish('w1', pr('MERGED'))
  prChangedFor('w1')
  await pass()
  assert.ok(state().tasks.a.mergedAt)
  assert.equal(app.started.length, 3, 'B and C still hold both places')

  finish('w2', pr('MERGED'))
  await pass()
  assert.deepEqual(app.started.map((s) => s.title), ['A', 'B', 'C', 'D'])
  assert.match(app.started[3].task, /## Already merged[\s\S]*- A/)

  // Archiving a merged workspace changes nothing.
  app.workspaces = app.workspaces.filter((w) => w.id !== 'w1')
  finish('w3', pr('MERGED'))
  finish('w4', pr('MERGED'))
  await pass()
  assert.deepEqual(app.notes.map((n) => n.title), ['Your turn: Ship it'])
  await pass()
  assert.equal(app.notes.length, 1, 'told once')

  await request('r1', 'shop', 'done', { taskId: 'ship' })
  await pass()
  assert.equal(state().auto, false)
  assert.ok(state().finishedAt)
  assert.deepEqual(app.notes.map((n) => n.title), ['Your turn: Ship it', 'Shop is done'])
  assert.equal(app.started.length, 4)
})

test('asks an agent to fix failing checks once per set of failures, then tells the person', async () => {
  await request('r1', 'shop', 'run')
  await pass()
  finish('w1', pr('OPEN', ['test']))
  await pass()
  assert.deepEqual(app.messages.map((m) => m.id), ['w1'])
  assert.match(app.messages[0].message, /failing on your pull request: test\./)
  await pass()
  assert.equal(app.messages.length, 1)
  finish('w1', pr('OPEN', ['test', 'lint']))
  await pass()
  finish('w1', pr('OPEN', ['lint']))
  await pass()
  assert.equal(app.messages.length, 3)
  finish('w1', pr('OPEN', ['build']))
  await pass()
  assert.equal(app.messages.length, 3, 'three tries, then it is the person\'s')
  assert.deepEqual(app.notes.map((n) => [n.title, n.workspaceId]), [['A is stuck', 'w1']])
})

test('carries out single-task requests and leaves a paused plan alone', async () => {
  await request('r1', 'shop', 'start', { taskId: 'c' })
  await request('r1', 'shop', 'start', { taskId: 'd' })
  await request('r1', 'shop', 'start', { taskId: 'ship', force: true })
  await pass()
  assert.deepEqual(app.started.map((s) => s.title), ['C'], 'D waits on A; a manual task never gets an agent')
  assert.equal(state().auto, false)

  await request('r1', 'shop', 'start', { taskId: 'd', force: true })
  await request('r1', 'shop', 'done', { taskId: 'a' })
  await pass()
  assert.deepEqual(app.started.map((s) => s.title), ['C', 'D'])
  assert.ok(state().tasks.a.doneAt)

  await request('r1', 'shop', 'undone', { taskId: 'a' })
  await request('r1', 'shop', 'reset', { taskId: 'c' })
  await pass()
  assert.deepEqual(Object.keys(state().tasks).sort(), ['a', 'd'])
  assert.equal(state().tasks.a.doneAt, undefined)
  assert.equal(app.started.length, 2, 'nothing starts by itself while the plan is paused')
})

test('a start that fails shows on the task and is retried when the plan runs again', async () => {
  app.failStart = 'git worktree add failed'
  await request('r1', 'shop', 'run')
  await pass()
  assert.equal(state().tasks.a.error, 'git worktree add failed')
  assert.equal(state().tasks.b, undefined, 'stops at the first failure')
  assert.equal(state().auto, false, 'and pauses, so the same failure is not repeated down the list')
  assert.deepEqual(app.notes.map((n) => [n.title, n.body]), [["Couldn't start A", 'The plan is paused. git worktree add failed']])
  await pass()
  assert.equal(app.notes.length, 1)

  app.failStart = 'Plan board already has 8 agents running. Wait for one to finish.'
  await request('r1', 'shop', 'run')
  await pass()
  assert.deepEqual(state().tasks, {}, "the app's limit isn't the task's error")
  assert.equal(state().auto, true)

  app.failStart = null
  await pass()
  assert.deepEqual(app.started.map((s) => s.title), ['A', 'B'])
})

test('forgets a plan whose file is gone, and ignores requests that make no sense', async () => {
  await request('r1', 'shop', 'run')
  await pass()
  app.files.delete(planPath('shop'))
  await app.store.set('req:junk', 'nope')
  await request('r1', '../etc', 'run')
  await request('r1', 'missing', 'run')
  await pass()
  assert.deepEqual([...app.store.keys()], [])
})

test('gives the orchestrator its tools', async () => {
  const ctx = { repoIds: ['r1'] }
  assert.match(tools.plan_help(), /Splitting work/)
  await assert.rejects(() => tools.plan_write({ name: 'new', markdown: '## A\n- depends on: nope\n' }, ctx), /Not saved[\s\S]*Line 1: "A" depends on "nope"/)
  await assert.rejects(() => tools.plan_write({ name: 'Bad Name', markdown: '## A\n' }, ctx), /plan name is lowercase/)
  await assert.rejects(() => tools.plan_write({ name: 'new', markdown: '## A\n', repo_id: 'r9' }, ctx), /isn't one of your projects/)
  await assert.rejects(() => tools.plan_write({ name: 'new', markdown: '## A\n' }, { repoIds: ['r1', 'r2'] }), /Say which project with repo_id: r1 \(shop\), r2 \(docs\)/)
  assert.match(await tools.plan_write({ name: 'new', markdown: '## A\n## B\n- depends on: a' }, ctx), /Saved new: 2 tasks in 2 steps, up to 3 at once\. First to start: a\./)
  assert.equal(app.files.get(planPath('new')), '## A\n## B\n- depends on: a\n')
  assert.ok(app.store.get('files'))

  assert.deepEqual((await tools.plan_list({}, ctx)).map((p) => [p.name, p.title, p.running, p.progress]), [
    ['shop', 'Shop', false, '0 of 5 done · 3 ready'],
    ['new', 'new', false, '0 of 2 done · 1 ready']
  ])
  await assert.rejects(() => tools.plan_read({ name: 'nope' }, ctx), /no plan called nope\. Plans here: shop, new\./)

  assert.match(await tools.plan_start({ name: 'shop' }, ctx), /Shop is running\. 0 of 5 done · 2 running · 1 ready\. Working now: A \(workspace w1\); B \(workspace w2\)\./)
  finish('w1', pr('OPEN', ['test']))
  await pass()
  const read = await tools.plan_read({ name: 'shop' }, ctx)
  assert.equal(read.running, true)
  assert.equal(read.markdown, PLAN)
  assert.deepEqual(read.tasks[0], { id: 'a', title: 'A', status: 'Checks failing', workspace_id: 'w1', pull_request: 'https://x/pull/1', failing_checks: ['test'] })
  assert.deepEqual(read.tasks[3], { id: 'd', title: 'D', status: 'Waiting', waiting_on: ['a'] })

  assert.match(await tools.plan_pause({ name: 'shop' }, ctx), /paused/)
  assert.equal(state().auto, false)
})
