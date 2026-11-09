# Choo Choo add-ons

Private add-ons for [Choo Choo](https://github.com/Benbentwo/choo-choo). This repo is an add-on source: a Claude Code plugin marketplace whose plugins also carry a `choo-choo.addon.json`.

## Use it

In Choo Choo, open Settings › Add-ons, type `Benbentwo/choo-choo-addons` into **Add source**, then install what it offers. The repo is private, so this works for anyone whose own git and GitHub access can read it.

To have a project ask its team for an add-on, add this to the project's `choo-choo.json`:

```json
{
  "addons": {
    "sources": ["Benbentwo/choo-choo-addons"],
    "required": ["plan-board@choo-choo-addons"]
  }
}
```

## Add-ons

| Add-on | What it does |
|---|---|
| [Plan board](plan-board/README.md) | Splits a big piece of work into tasks, draws what depends on what, and runs each task as its own agent and pull request. A task starts when the ones it depends on are merged. |

## Writing one

`npm test` runs every add-on's tests.

Each add-on is a folder with `.claude-plugin/plugin.json` and `choo-choo.addon.json`, listed in `.claude-plugin/marketplace.json`. The manifest, the sandbox and the `window.choo` API are described in the [author guide](https://github.com/Benbentwo/choo-choo/blob/main/docs/addon-api.md).
