# Clean View

A Claude Code mod that makes Claude feel calm and friendly for people who aren't technical.

While Claude works, the tool calls, file changes and command output are hidden. One simple checklist sits above the prompt instead, showing the plan, what's happening now and how far along it is:

```
Build my landing page · 1m 12s                     [ ● Clean View: ON ]
✓ Read your brand notes            ██████████  Done
▶ Build the pricing section        ██████░░░░  60%
○ Add the contact form             ░░░░░░░░░░  Next
○ Polish the footer                ░░░░░░░░░░  Up next
```

The header also tells you when Claude **needs you** (a permission or a question), when it's **stuck** (in one plain sentence), when you **stopped** it, and when it's **all done**.

## Install

Type this at the prompt of a Claude Code terminal session:

```
/plugin install clean-view --marketplace spacewitch123/clean-view
```

Answer `y` to add the marketplace, then press Enter to install it for your user. It works straight away and in every session after.

## Turn it on and off

- Click **[ ● Clean View: ON ]** at the top right of the checklist to flip it.
- Or type `/simple off` to see everything again, `/simple on` to hide it, or `/simple` to flip it.

Clean View is on every time Claude Code starts. Turning it off lasts until you close that session. When it's off, everything Claude does shows again and only the button stays.

Clean View shares the space above the prompt with other mods, such as [Pulse](https://github.com/spacewitch123/pulse), so both show together.

## Good to know

- Each request costs a few more tokens while Clean View is on: Claude plans its steps, reports progress, and a small Haiku call names the job. Turning it off removes all of this.
- Claude is asked to make a plan before it does anything else, so the checklist always has something to show.

## For developers

Checks and tests, run from this folder:

```
claude plugin validate .
claude plugin test .
```

The checklist lives in plugin state under `clean-view` (`cleanViewEnabled`, `checklist`, `tick`), typed in `types/index.d.ts`, so other mods can read it.
