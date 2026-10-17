---
name: forge-sites
description: List and inspect sites on Laravel Forge servers. Triggers on "list sites", "show site", "site detail", "what sites are on server X".
---

# Forge Sites

List sites on a server or inspect a specific site.

## List sites on a server

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php sites <server>
```

`<server>` can be a server name, IP address, or numeric ID. Output: `{"sites":[...]}`, each entry with `id` and `name`.

## Show site detail

```bash
php ${CLAUDE_PLUGIN_ROOT}/php/forge.php site <server> <site>
```

`<site>` can be a site name, URL hostname, or numeric ID. Returns the canonical site record as JSON, including ID, name, status, and repository info.

## Notes

- An unmatched or ambiguous name (multiple matches on the same server) returns `status` `no_match` or `ambiguous` with `choices` to pick from.
- For deployment history or triggering deploys, use `/hermitd-laravel-forge:forge-deploy`.
- For reading site or deployment logs, use `/hermitd-laravel-forge:forge-logs`.
