# Reddit integration

`scripts/reddit-fetch.ts` fetches the hot posts of a subreddit. It **works out of the box with
no setup** — it hits Reddit's public JSON endpoint unauthenticated. Credentials are optional and
only raise your rate limit.

Reddit sources (`type: reddit` in `feed-sources.md`) resolve through this fallback chain:

```
reddit-fetch.ts → Chrome → skip (mark sources_skipped)
```

If the script reports Reddit unavailable and no Chrome session is available, the source is
skipped for that run and recorded in `sources_skipped`.

## Why a script (not WebFetch)

`reddit.com` blocks plain `WebFetch`, and the per-subreddit `.rss` feed frequently returns `403`.
The JSON endpoint (`/r/<sub>/hot.json`) is reliably reachable with a custom User-Agent, which is
why this script exists instead of listing subreddits as `rss` sources.

## Usage

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/reddit-fetch.ts <subreddit> [limit]
```

| Argument     | Description                                        | Default |
| ------------ | -------------------------------------------------- | ------- |
| `subreddit`  | Subreddit name, with or without a leading `r/`     | required |
| `limit`      | Number of posts to fetch                           | 20      |

A leading `r/` is stripped automatically. Stickied posts are dropped.

**Examples:**

```bash
bun ${CLAUDE_PLUGIN_ROOT}/scripts/reddit-fetch.ts LocalLLaMA
bun ${CLAUDE_PLUGIN_ROOT}/scripts/reddit-fetch.ts r/example 10
```

**Output**: one JSON object on stdout:

```json
{
  "posts": [
    {
      "title": "Example post title",
      "url": "https://example.com/linked-article",
      "score": 1200,
      "comments": 340,
      "permalink": "https://reddit.com/r/example/comments/abc123"
    }
  ]
}
```

`url` is the post's outbound link (the linked article), while `permalink` is the Reddit comment
thread.

## Outcomes

| Output | Exit | Pipeline behavior |
| ------ | ---- | ----------------- |
| `{"posts":[...]}` | `0` | Map the posts into items |
| `{"status":"unavailable","reason":"http_403"}` (also `http_<code>`, `network_error`, `invalid_response`) | `0` | Fall back: Chrome → skip |
| `{"error":"usage"}` | `1` | Bad arguments; fall back: Chrome → skip |

There is no "not configured" state: missing credentials is not an error, the script just uses
the unauthenticated path.

## Optional: authenticated path (higher rate limits)

For heavier use, set OAuth credentials and the script switches to Reddit's OAuth2
client-credentials flow automatically. No `pip`, no `praw`, no extra install — it calls the token
endpoint directly with `fetch`.

1. Create a Reddit **script** app at [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps):
   click **create another app**, choose **script**, and use any redirect URI (e.g.
   `http://localhost:8080`). Note the **client_id** (under the app name) and the **secret**.
2. Set these environment variables (in the project's gitignored `.env`):

   ```
   REDDIT_CLIENT_ID=your_client_id
   REDDIT_CLIENT_SECRET=your_client_secret
   REDDIT_USER_AGENT=hermit/1.0 (by u/your_username)
   ```

- `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` — when BOTH are set, the script requests an OAuth
  token and reads from `oauth.reddit.com`. If the token request fails, it falls back to the
  unauthenticated endpoint automatically.
- `REDDIT_USER_AGENT` — optional. Defaults to `hermit/1.0 (feed bot)`. Reddit's API terms ask
  for a descriptive User-Agent; set your own for the authed path.

Credentials never change the output shape or exit codes, only the rate limit and endpoint.
