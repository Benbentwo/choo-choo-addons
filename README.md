# Choo Choo add-ons

Add-ons for [Choo Choo](https://github.com/Benbentwo/choo-choo). This repo is an add-on source: a Claude Code plugin marketplace whose plugins also carry a `choo-choo.addon.json`.

## Use it

In Choo Choo, open Settings › Add-ons, type `Benbentwo/choo-choo-addons` into **Add source**, then install what it offers. Turning an add-on on shows what it is allowed to do before anything runs.

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

## Your team's own add-ons

A team's private add-ons don't belong in a fork of this repo, because a fork of a public repo is public too. Keep them in a private repo of your own with the same layout, and add it as a second source beside this one. Choo Choo fetches a source with each person's own git access, so a private source works for anyone who can read the repo.

If you do fork this repo to change an add-on, give your copy its own name first: change `name` in `.claude-plugin/marketplace.json` (for example to `acme-addons`). An add-on is known by `name@source`, so the Plan board in your copy becomes `plan-board@acme-addons`, and it can sit beside this one without the two being mistaken for each other. Plans are files in your project, so they carry over. What the board remembers about tasks already started does not.

## Contributing

Fixes and new add-ons are welcome as pull requests. Run `npm test` first. An add-on here should work for any team, ask only for the permissions it uses, and need nothing but Choo Choo and the person's own Claude sign-in. Report a security problem the way the [app's security policy](https://github.com/Benbentwo/choo-choo/blob/main/SECURITY.md) describes, not in a public issue.

## License

[MIT](LICENSE)
