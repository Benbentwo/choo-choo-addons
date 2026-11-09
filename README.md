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

None yet. The Plan board is first.

## Writing one

Each add-on is a folder with `.claude-plugin/plugin.json` and `choo-choo.addon.json`, listed in `.claude-plugin/marketplace.json`. The manifest, the sandbox and the `window.choo` API are described in the [author guide](https://github.com/Benbentwo/choo-choo/blob/main/docs/addon-api.md).
