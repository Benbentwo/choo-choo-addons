import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GUIDE, columns, decide, parsePlan, setSetting, slug, starterPlan, statuses, steps, summary, summaryText, taskPrompt, unblocks, waitingOn } from '../ui/plan.js'

const PLAN = `---
title: "Billing v2"
parallel: 2
model: sonnet
---

# Ignored heading

Use the money helpers in lib/money.

## Schema
- id: schema
- model: opus

Add the invoices table.

### Done when
- [ ] Migration runs
- [x] Model has tests
  that cover refunds

## Invoice API
depends on: schema

Endpoints.

### Notes
Keep it REST.

## Invoice page
- id: page
- depends on: schema, invoice-api

## Emails
- id: emails
- after: schema

## Check staging
- id: staging
- depends on: page, emails
- manual: yes
`

test('reads settings, context, tasks and done-when lists', () => {
  const p = parsePlan(PLAN)
  assert.deepEqual(p.problems, [])
  assert.equal(p.title, 'Billing v2')
  assert.equal(p.parallel, 2)
  assert.equal(p.model, 'sonnet')
  assert.equal(p.context, 'Use the money helpers in lib/money.')
  assert.deepEqual(p.tasks.map((t) => t.id), ['schema', 'invoice-api', 'page', 'emails', 'staging'])
  const [schema, api, page, emails, staging] = p.tasks
  assert.equal(schema.model, 'opus')
  assert.equal(schema.brief, 'Add the invoices table.')
  assert.deepEqual(schema.doneWhen, ['Migration runs', 'Model has tests that cover refunds'])
  assert.deepEqual(api.depends, ['schema'])
  assert.equal(api.brief, 'Endpoints.\n\n### Notes\nKeep it REST.')
  assert.deepEqual(page.depends, ['schema', 'invoice-api'])
  assert.deepEqual(emails.depends, ['schema'])
  assert.equal(staging.manual, true)
  assert.equal(schema.line, 11)
})

test('a plan with no settings still reads, and takes its title from the first heading', () => {
  const p = parsePlan('# Tidy up\n\nNotes.\n\n## One\n\nDo it.\n\n## Two\n- depends on: one\n')
  assert.deepEqual(p.problems, [])
  assert.equal(p.title, 'Tidy up')
  assert.equal(p.parallel, 3)
  assert.equal(p.context, 'Notes.')
  assert.deepEqual(p.tasks.map((t) => [t.id, t.depends]), [['one', []], ['two', ['one']]])
})

test('headings inside code fences are not tasks, and text that looks like a setting stays in the brief', () => {
  const p = parsePlan('## One\n- id: one\n\nNote: keep this.\n\n```md\n## Not a task\n```\n\n~~~\n### Done when\n- nope\n~~~\n')
  assert.equal(p.tasks.length, 1)
  assert.match(p.tasks[0].brief, /^Note: keep this\./)
  assert.match(p.tasks[0].brief, /## Not a task/)
  assert.deepEqual(p.tasks[0].doneWhen, [])
})

test('says what is wrong with a plan', () => {
  const messages = (text) => parsePlan(text).problems.map((p) => p.message)
  assert.match(messages('')[0], /no tasks/)
  assert.match(messages('---\ntitle: x\n\n## A\n')[0], /never close/)
  assert.match(messages('---\nparallel: 20\nmodel: gpt\n---\n## A\n').join('\n'), /parallel must be[\s\S]*Model "gpt"/)
  assert.match(messages('## A\n- id: Bad Id\n')[0], /can't be a task id/)
  assert.match(messages('## Same\n\n## Same\n')[0], /Two tasks have the id "same"/)
  assert.match(messages('## A\n- depends on: nope\n')[0], /depends on "nope"/)
  assert.match(messages('## A\n- depends on: a\n')[0], /depends on itself/)
  assert.match(messages('## A\n- depends on: c\n## B\n- depends on: a\n## C\n- depends on: b\n')[0], /in a circle: a → c → b → a/)
  assert.match(messages('## !!!\n')[0], /an id line/)
  const p = parsePlan('## A\n- depends on: nope\n')
  assert.equal(p.problems[0].line, 1)
})

test('lays tasks out in steps', () => {
  const p = parsePlan(PLAN)
  assert.deepEqual([...steps(p)], [['schema', 0], ['invoice-api', 1], ['page', 2], ['emails', 1], ['staging', 3]])
  assert.deepEqual(columns(p), [['schema'], ['invoice-api', 'emails'], ['page'], ['staging']])
  // A broken plan still draws.
  assert.deepEqual(columns(parsePlan('## A\n- depends on: b\n## B\n- depends on: a, gone\n')).flat().sort(), ['a', 'b'])
})

test('orders a column by where its dependencies sit', () => {
  const p = parsePlan('## A\n## B\n## Needs b\n- depends on: b\n## Needs a\n- depends on: a\n')
  assert.deepEqual(columns(p), [['a', 'b'], ['needs-a', 'needs-b']])
})

const ws = (id, status) => ({ id, status })
const pr = (over = {}) => ({ number: 7, url: 'u', state: 'OPEN', isDraft: false, mergeState: 'CLEAN', checks: { total: 2, passed: 2, pending: 0, failed: [] }, ...over })

test('works out each task status', () => {
  const p = parsePlan(PLAN)
  assert.deepEqual(statuses(p), { schema: 'ready', 'invoice-api': 'waiting', page: 'waiting', emails: 'waiting', staging: 'waiting' })

  const st = (records, workspaces) => statuses(p, records, workspaces)
  assert.equal(st({ schema: { ws: 'w1' } }, [ws('w1', 'running')]).schema, 'running')
  assert.equal(st({ schema: { ws: 'w1' } }, [ws('w1', 'needs-approval')]).schema, 'approval')
  assert.equal(st({ schema: { ws: 'w1' } }, [ws('w1', 'in-cloud')]).schema, 'cloud')
  assert.equal(st({ schema: { ws: 'w1' } }, [ws('w1', 'error')]).schema, 'error')
  assert.equal(st({ schema: { ws: 'w1' } }, [ws('w1', 'idle')]).schema, 'stopped')
  assert.equal(st({ schema: { ws: 'w1' } }, []).schema, 'gone')
  assert.equal(st({ schema: { error: 'no git' } }, []).schema, 'error')
  assert.equal(st({ schema: { ws: 'w1', pr: pr() } }, [ws('w1', 'idle')]).schema, 'review')
  assert.equal(st({ schema: { ws: 'w1', pr: pr({ isDraft: true }) } }, [ws('w1', 'idle')]).schema, 'draft')
  assert.equal(st({ schema: { ws: 'w1', pr: pr({ checks: { total: 2, passed: 1, pending: 1, failed: [] } }) } }, [ws('w1', 'idle')]).schema, 'checking')
  assert.equal(st({ schema: { ws: 'w1', pr: pr({ checks: { total: 2, passed: 1, pending: 0, failed: ['test'] } }) } }, [ws('w1', 'idle')]).schema, 'failing')
  assert.equal(st({ schema: { ws: 'w1', pr: pr({ mergeState: 'DIRTY' }) } }, [ws('w1', 'idle')]).schema, 'conflict')
  assert.equal(st({ schema: { ws: 'w1', pr: pr({ state: 'CLOSED' }) } }, [ws('w1', 'idle')]).schema, 'closed')
  // A working agent wins over what its pull request says.
  assert.equal(st({ schema: { ws: 'w1', pr: pr({ checks: { total: 1, passed: 0, pending: 0, failed: ['test'] } }) } }, [ws('w1', 'running')]).schema, 'running')
  // Merged stays merged after the workspace is archived.
  assert.equal(st({ schema: { ws: 'w1', mergedAt: 5 } }, []).schema, 'merged')
  assert.equal(st({ schema: { ws: 'w1', pr: pr({ state: 'MERGED' }) } }, []).schema, 'merged')

  const later = st({ schema: { mergedAt: 1 }, 'invoice-api': { doneAt: 2 }, emails: { mergedAt: 3 }, page: { mergedAt: 4 } }, [])
  assert.deepEqual(later, { schema: 'merged', 'invoice-api': 'done', page: 'merged', emails: 'merged', staging: 'todo' })
  const mid = st({ schema: { mergedAt: 1 } }, [])
  assert.deepEqual(mid, { schema: 'merged', 'invoice-api': 'ready', page: 'waiting', emails: 'ready', staging: 'waiting' })
  assert.deepEqual(waitingOn(p, mid, p.tasks[2]), ['invoice-api'])
  assert.deepEqual(unblocks(p, p.tasks[0]).map((t) => t.id), ['invoice-api', 'page', 'emails'])
})

test('sums a plan up', () => {
  const p = parsePlan(PLAN)
  const status = statuses(p, { schema: { mergedAt: 1 }, 'invoice-api': { ws: 'w1' }, emails: { ws: 'w2', pr: pr({ checks: { total: 1, passed: 0, pending: 0, failed: ['lint'] } }) } }, [ws('w1', 'needs-approval'), ws('w2', 'idle')])
  const s = summary(p, status)
  assert.deepEqual(s, { total: 5, done: 1, working: 0, needsYou: 1, failing: 1, review: 0, ready: 0, waiting: 2 })
  assert.equal(summaryText(s), '1 of 5 done · 1 needs you · 1 failing')
})

test('starts ready tasks up to the limit, in file order, only while the plan is running', () => {
  const p = parsePlan('---\nparallel: 2\n---\n## A\n## B\n## C\n## D\n- depends on: a\n')
  const go = (state, workspaces = []) => decide(p, state, statuses(p, state.tasks, workspaces))
  assert.deepEqual(go({ auto: false, tasks: {} }).start, [])
  assert.deepEqual(go({ auto: true, tasks: {} }).start, ['a', 'b'])
  assert.deepEqual(go({ auto: true, tasks: { a: { ws: 'w1' } } }, [ws('w1', 'running')]).start, ['b'])
  // An agent waiting for approval still holds its place.
  assert.deepEqual(go({ auto: true, tasks: { a: { ws: 'w1' }, b: { ws: 'w2' } } }, [ws('w1', 'needs-approval'), ws('w2', 'running')]).start, [])
  // One in review doesn't.
  assert.deepEqual(go({ auto: true, tasks: { a: { ws: 'w1', pr: pr() }, b: { ws: 'w2' } } }, [ws('w1', 'idle'), ws('w2', 'running')]).start, ['c'])
  // Merging A opens D.
  assert.deepEqual(go({ auto: true, tasks: { a: { mergedAt: 1 }, b: { mergedAt: 1 }, c: { ws: 'w3' } } }, [ws('w3', 'running')]).start, ['d'])
  const end = go({ auto: true, tasks: { a: { mergedAt: 1 }, b: { mergedAt: 1 }, c: { doneAt: 1 }, d: { mergedAt: 2 } } })
  assert.deepEqual([end.start, end.finished], [[], true])
  // A plan with problems never starts anything.
  const broken = parsePlan('## A\n- depends on: nope\n## B\n')
  assert.deepEqual(decide(broken, { auto: true, tasks: {} }, statuses(broken)).start, [])
})

test('messages an idle agent about failing checks once per set of failures, and gives up after three', () => {
  const p = parsePlan('## A\n')
  const failing = (names, nudge) => ({ auto: true, tasks: { a: { ws: 'w1', pr: pr({ checks: { total: 2, passed: 0, pending: 0, failed: names } }), nudge } } })
  const go = (state, status = 'idle') => decide(p, state, statuses(p, state.tasks, [ws('w1', status)])).nudge
  const first = go(failing(['test', 'lint']))
  assert.equal(first.length, 1)
  assert.equal(first[0].sig, 'checks:lint|test')
  assert.match(first[0].message, /test, lint/)
  assert.deepEqual(go(failing(['lint', 'test'], { sig: 'checks:lint|test', count: 1 })), [])
  assert.equal(go(failing(['lint'], { sig: 'checks:lint|test', count: 1 })).length, 1)
  assert.deepEqual(go(failing(['lint'], { sig: 'checks:lint|test', count: 3 })), [])
  assert.deepEqual(go(failing(['lint']), 'running'), [])
  assert.deepEqual(go({ ...failing(['lint']), auto: false }), [])
  const conflict = { auto: true, tasks: { a: { ws: 'w1', pr: pr({ mergeState: 'DIRTY' }) } } }
  assert.equal(go(conflict)[0].sig, 'conflict')
})

test("writes the agent's brief", () => {
  const p = parsePlan(PLAN)
  const text = taskPrompt(p, p.tasks[2])
  assert.match(text, /one task of a larger plan, "Billing v2"/)
  assert.match(text, /## Your task: Invoice page/)
  assert.match(text, /## About the plan\n\nUse the money helpers/)
  assert.match(text, /## Already merged[\s\S]*- Schema\n- Invoice API/)
  assert.match(text, /## Not yours[\s\S]*- Emails\n- Check staging/)
  assert.match(text, /open a pull request/)
  assert.match(taskPrompt(p, p.tasks[0]), /## Done when\n\n- Migration runs/)
})

test('changes one setting and keeps the rest of the file', () => {
  assert.equal(setSetting('---\ntitle: X\nparallel: 2\n---\n\n## A\n', 'parallel', 5), '---\ntitle: X\nparallel: 5\n---\n\n## A\n')
  assert.equal(setSetting('---\ntitle: X\n---\n## A\n', 'parallel', 5), '---\ntitle: X\nparallel: 5\n---\n## A\n')
  assert.equal(setSetting('## A\n', 'parallel', 4), '---\nparallel: 4\n---\n\n## A\n')
  assert.equal(parsePlan(setSetting(PLAN, 'parallel', 6)).parallel, 6)
})

test('the starter plan and the guide are valid plans', () => {
  assert.deepEqual(parsePlan(starterPlan('New thing')).problems, [])
  const example = GUIDE.slice(GUIDE.indexOf('---'), GUIDE.indexOf('Rules:'))
  const p = parsePlan(example)
  assert.deepEqual(p.problems, [])
  assert.deepEqual(p.tasks.map((t) => t.id), ['invoice-model', 'invoice-api', 'check-staging'])
  assert.equal(slug('  Héllo, World!  '), 'h-llo-world')
})
