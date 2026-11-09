---
name: writing-plans
description: Write or revise a Plan board plan, a Markdown file that splits a large piece of work into tasks for agents working side by side. Use when asked to plan, break down or sequence work that is too big for one pull request, or to edit a file in .choo-choo/plans/.
---

# Writing a plan

A plan lives in the project at `.choo-choo/plans/<name>.plan.md`. The Plan board add-on for Choo Choo draws it as a graph and runs it: each task becomes one agent in its own worktree, with one branch and one pull request, and a task starts when the tasks it depends on are merged.

`<name>` is lowercase letters, digits and dashes, at most 32 characters.

## The file

```markdown
---
title: Billing v2
parallel: 3
---

What every agent should know: the goal, conventions, where the spec is. Every task's agent gets this text.

## Invoice model
- id: invoice-model
- model: opus

The brief: what to build, in enough detail for an agent that has seen nothing else.

### Done when
- Migration and model exist, with tests

## Invoice API
- id: invoice-api
- depends on: invoice-model

Endpoints to create, list and void invoices.

### Done when
- Each endpoint has a request test

## Check staging
- id: check-staging
- depends on: invoice-api
- manual: yes

Something a person does and ticks off on the board.
```

- Each `## ` heading is a task. The lines right under it set it up: `id` (lowercase letters, digits, dashes; defaults to the title), `depends on` (task ids, separated by commas), `model` (opus, fable, sonnet, haiku or codex; optional) and `manual: yes` for a step a person does.
- `parallel` at the top is how many agents may work at once, 1 to 8. The default is 3.
- Text above the first task goes to every agent. Put shared conventions there once instead of in every brief.
- `### Done when` is a list the agent checks itself against.

## Splitting the work

1. Read the code first. Tasks should follow the seams that are really there (a module, an endpoint, a screen), and briefs should name real files.
2. Make each task small enough to review as one pull request, and complete enough to merge on its own without breaking the build.
3. Add `depends on` only where a task needs another task's code. Tasks with no link between them run side by side, so fewer links means a faster plan. A task starts from the default branch as it is when its dependencies have merged.
4. Two tasks that would edit the same files should be one task, or one should depend on the other. Agents working side by side can't see each other's changes, and their pull requests will conflict.
5. Put shared groundwork (a schema, types, an interface both sides code against) in an early task that the others depend on.
6. Write each brief for someone with no context: what to build, where, and what to leave alone.
7. End with manual tasks for what only a person can do: a production check, a credential, a sign-off.

## Before you finish

- Every `depends on` names an id that exists, and nothing depends on itself or in a circle.
- No two tasks share an id.
- In a workspace, the file you write is in that workspace's branch. The Plan board reads plans from the project's main checkout, so the plan shows up there once your branch is merged, or when the person copies the file over. If the person wants the plan on the board now, tell them that, and suggest asking the project's orchestrator, whose `plan_write` tool saves it in the right place.
