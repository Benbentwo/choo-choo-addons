/** Small DOM helpers and the pieces both views show. */
import { STATUS, isDone, unblocks, waitingOn } from './plan.js'

/** h('div.card', { onclick }, child, …): an element with classes, properties and children. */
export function h(spec, props, ...children) {
  const [tag, ...classes] = spec.split('.')
  const el = document.createElement(tag || 'div')
  if (classes.length) el.className = classes.join(' ')
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'data') Object.assign(el.dataset, v)
    else if (k in el && k !== 'list') el[k] = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c)
  return el
}

export function pill(status) {
  const s = STATUS[status]
  return h('span.pill', { data: { tone: s.tone, status } }, s.label)
}

const list = (names) => (names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`)

/** The line under a card's title: what the task is waiting for, or how its pull request is doing. */
export function metaLine(plan, task, status, rec, workspace) {
  const st = status[task.id]
  const title = (id) => plan.tasks.find((t) => t.id === id)?.title ?? id
  if (st === 'waiting') return `Waiting on ${list(waitingOn(plan, status, task).map(title))}`
  if (st === 'ready') return 'Everything it needs is done'
  if (st === 'todo') return 'Tick it off when you have done it'
  if (st === 'done') return task.manual ? 'Ticked off' : 'Marked done by hand'
  if (st === 'error' && !rec?.ws) return rec?.error ?? ''
  const pr = rec?.pr
  if (pr) {
    const c = pr.checks
    const checks = c.failed.length ? `${c.failed.length} of ${c.total} checks failing` : c.pending ? `${c.passed} of ${c.total} checks passed` : c.total ? 'checks passed' : ''
    const review = pr.state === 'OPEN' && pr.review === 'APPROVED' ? 'approved' : pr.state === 'OPEN' && pr.review === 'CHANGES_REQUESTED' ? 'changes requested' : ''
    return [`#${pr.number}`, st === 'merged' ? '' : checks, review].filter(Boolean).join(' · ')
  }
  if (st === 'gone') return 'Its workspace was archived before a pull request merged'
  return workspace?.branch ?? rec?.branch ?? ''
}

/** Depends on, unblocks, the brief and the done-when list. `pick` is called with a task id when one is clicked. */
export function taskDetail(plan, task, status, pick) {
  const link = (t) => h(pick ? 'button.link' : 'div.link', { onclick: pick && (() => pick(t.id)) }, h('span', {}, t.title), pill(status[t.id]))
  const needs = task.depends.map((d) => plan.tasks.find((t) => t.id === d)).filter(Boolean)
  const next = unblocks(plan, task)
  return h(
    'div.detail',
    {},
    needs.length ? h('section', {}, h('h3', {}, 'Depends on'), h('div.links', {}, needs.map(link))) : null,
    next.length ? h('section', {}, h('h3', {}, isDone(status[task.id]) ? 'Unblocked' : 'Unblocks'), h('div.links', {}, next.map(link))) : null,
    h('section', {}, h('h3', {}, 'Brief'), task.brief ? h('pre.brief', {}, task.brief) : h('div.faint', {}, 'No brief yet. Edit the plan to write one.')),
    task.doneWhen.length ? h('section', {}, h('h3', {}, 'Done when'), h('ul.checks', {}, task.doneWhen.map((d) => h('li', {}, d)))) : null
  )
}

/** Calls `fn` once things have been quiet for `ms`. */
export function debounce(fn, ms) {
  let timer
  return () => {
    clearTimeout(timer)
    timer = setTimeout(fn, ms)
  }
}
