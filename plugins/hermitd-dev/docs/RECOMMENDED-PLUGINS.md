# Recommended Plugins

Optional plugins that pair well with a dev hermit. `/hermitd-dev:hatch` installs none of them; install the ones you want yourself.

---

## context7

GitHub: [upstash/context7](https://github.com/upstash/context7)

```bash
claude plugin install context7@claude-plugins-official --scope project
```

Live documentation lookup for framework APIs. Instead of relying on training data (which may be outdated), context7 fetches current docs for libraries like React, Next.js, Django, Express, etc. Useful when the agent is working with frameworks whose API details change between versions.
