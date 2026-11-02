# What Your Assistant Can and Cannot Do

A plain-language answer to "what is this thing actually allowed to do?" — written for the owner, not the developer. It's derived from the technical [Security](security.md) doc, and it's deliberately honest: it says where the guarantees are real and where they're a strong habit rather than an unbreakable rule.

---

## Always true

These are hard limits — enforced mechanically, not just as good behavior:

- It will never run a command that wipes your whole disk, destroys a drive, or takes down the system it's running on. Those specific dangerous actions are blocked no matter what, regardless of anything it decides in the moment.
- If it was set up the recommended way (the always-on container setup), it's also blocked from pushing code changes to your team's shared repository without approval first. On other setups this protection may not be switched on — ask whoever installed it if you're unsure which applies to you.

---

## How it normally works

These are the assistant's everyday habits — real, and followed consistently, but not absolute walls:

- Before making a significant or risky change, it shows you a draft and waits for your OK rather than just doing it (see [Approve](owners-guide.md#approve)).
- It tracks what it spends on AI usage and can warn you or pause itself against a spending limit you set.
- It generally stays scoped to the project it's working in, rather than roaming freely across your whole computer.
- To make a change stick, say "from now on". A complaint on its own is remembered, but it doesn't change how a task is done.
- Ask what it is keeping an eye on and it answers in one place: its scheduled routines, anything it is watching right now, and the standing rules you gave it. Ask it to pause or disable one by name and it uses that item's own control, telling you whether the change lasts past a restart.

---

## Honest limits

Nobody should be told this is a sealed box, so here's what it isn't:

- By default, it can still read files and reach the internet — those aren't blocked automatically. If your work needs that locked down, ask whoever set this up about the stronger, opt-in network protection.
- The "shows me a draft first" habit above is just that — a habit the assistant follows, not a guarantee enforced the way the destructive-action blocks are. In an unusual or confusing situation, it could occasionally act without asking first.
- This isn't a substitute for basic caution. Don't give it access to anything you wouldn't want touched, and keep an eye on what it's doing — especially in the first few weeks.

If your situation needs stronger guarantees than described here — handling sensitive client data, for example — talk to whoever set this up about running it inside a more locked-down environment.
