<?php
declare(strict_types=1);

// ---------------------------------------------------------------------------
// Shared helpers, derived predicates and the reachability policy for forge.php
// and its test harness.
//
// Safe to `require` from both the CLI dispatch script and php/tests/run.php, so
// the tests exercise the SAME matchers and policy the CLI ships.
//
// The read surface used to be a hand-maintained allowlist of ~100 method names.
// It is now the whole SDK minus two deny tiers, because the Forge API token is
// what authorizes an operation — this plugin's job is autonomy and context
// hygiene, not authorization. Everything below is DERIVED from the installed SDK
// by reflection or read off the captured request, so no list can drift.
// ---------------------------------------------------------------------------

use Laravel\Forge\Forge;
use Laravel\Forge\Exceptions\ValidationException;
use Psr\Http\Message\RequestInterface;

// ---------------------------------------------------------------------------
// Derived predicates
// ---------------------------------------------------------------------------

/**
 * True for a real Forge API operation.
 *
 * A public Forge method whose declaring file sits outside Actions/ is client
 * plumbing, not an API call: setApiKey can swap the auth header, and
 * get/post/put/patch/delete/retry bypass the named-method model entirely. One
 * check covers all 11 of them, and it self-maintains across SDK versions.
 *
 * Trait methods report their trait's file, which is exactly what this needs —
 * every endpoint lives in a trait under Actions/.
 */
function isEndpointMethod(string $method): bool
{
    if (!method_exists(Forge::class, $method)) return false;
    $rm = new \ReflectionMethod(Forge::class, $method);
    if (!$rm->isPublic()) return false;

    return str_starts_with(str_replace('\\', '/', (string) $rm->getFileName()), forgeActionsDir());
}

/**
 * The SDK's own `src/Actions/` directory, as an absolute prefix.
 *
 * Anchored to the directory holding Forge.php rather than matched as a bare
 * `/Actions/` substring: an install path that merely CONTAINS a directory named
 * `Actions` (e.g. a project at /srv/Actions/app) would otherwise make every
 * plumbing method — `get`, `post`, `delete`, `retry`, `setApiKey` — pass the
 * structural check, because their file paths contain that substring too.
 */
function forgeActionsDir(): string
{
    static $dir = null;
    if ($dir === null) {
        $src = dirname((string) (new \ReflectionClass(Forge::class))->getFileName());
        $dir = str_replace('\\', '/', $src) . '/Actions/';
    }

    return $dir;
}

/**
 * True when the method's first parameter is the org slug, so generic dispatch
 * knows whether to prepend it. Derived rather than listed: 19 endpoint methods
 * take no org slug, and a hardcoded list of them silently shifts every argument
 * by one the moment the SDK adds a 20th.
 */
function takesOrgFirst(string $method): bool
{
    $params = (new \ReflectionMethod(Forge::class, $method))->getParameters();

    return isset($params[0]) && $params[0]->getName() === 'organizationSlug';
}

// ---------------------------------------------------------------------------
// Shipped deny tiers
// ---------------------------------------------------------------------------

/** The tier names an operator can lift. */
const POLICY_TIERS = ['secrets', 'destructive'];

// Destructive is decided by the CAPTURED HTTP verb, never by the method name.
// A name pattern misses the real DELETEs: disableQuickDeploy and
// disablePushToDeploy both issue DELETE without a `delete` prefix.
const DESTRUCTIVE_VERBS = ['DELETE'];

// Secrets: methods that return credential material into the transcript.
//
// NOT denied, though an earlier draft denied all three — the SDK says otherwise:
//   serverKey()      docblock: "Get the server's public SSH key" (returns public_key)
//   deployKey()      DeployKey::$key is documented "The public deploy key"
//   storageProvider* 13 metadata fields (provider, bucket, region, endpoint…), zero credentials
const SECRET_METHODS = [
    'siteEnvironment', 'deploymentTriggerUrl',
    'composerCredential*', 'npmCredential*', 'serverCredential*', 'teamServerCredentials',
];

const SECRET_RETURN_TYPES = [
    'Laravel\Forge\Resources\ComposerCredential',
    'Laravel\Forge\Resources\NpmCredential',
    'Laravel\Forge\Resources\ServerCredential',
];

/** Exact name, or a single trailing-`*` prefix glob. Deliberately not regex —
 *  a policy pattern language is a place for mistakes to hide. */
function matchesPattern(string $method, array $patterns): bool
{
    foreach ($patterns as $pattern) {
        if (str_ends_with($pattern, '*')) {
            if (str_starts_with($method, substr($pattern, 0, -1))) return true;
        } elseif ($method === $pattern) {
            return true;
        }
    }

    return false;
}

function returnsSecretResource(string $method): bool
{
    $type = (new \ReflectionMethod(Forge::class, $method))->getReturnType();

    return $type instanceof \ReflectionNamedType
        && in_array(ltrim($type->getName(), '\\'), SECRET_RETURN_TYPES, true);
}

// ---------------------------------------------------------------------------
// Policy resolution
// ---------------------------------------------------------------------------

/**
 * Applied to the CAPTURED request, never to a prediction of what a method will
 * do. Returns null when the call is allowed, or a refusal that names the tier
 * AND the lift — the refusal text is what an agent relays to the operator
 * instead of improvising an escalation.
 */
function policyRefusal(string $method, RequestInterface $captured, array $policy): ?string
{
    // Structural, and never liftable: these are not Forge API operations.
    if (!isEndpointMethod($method)) {
        return "Refused: $method is not a Forge API operation (client plumbing or raw transport). "
             . "This is structural and cannot be lifted.";
    }

    $lifted = fn(string $tier) => in_array($tier, $policy['tiers_lifted'], true)
        || in_array($method, $policy['methods_lifted'], true);

    if ((matchesPattern($method, SECRET_METHODS) || returnsSecretResource($method)) && !$lifted('secrets')) {
        return policyLiftHint("Refused: $method — denied by shipped tier 'secrets' "
            . "(returns credential material into the transcript).", 'secrets', $method);
    }

    if (in_array(strtoupper($captured->getMethod()), DESTRUCTIVE_VERBS, true) && !$lifted('destructive')) {
        return policyLiftHint("Refused: $method — denied by shipped tier 'destructive' "
            . "(captured verb {$captured->getMethod()}).", 'destructive', $method);
    }

    // Project denials are operator convenience, not a boundary — see loadPolicy().
    if (matchesPattern($method, $policy['project_deny'])) {
        return "Refused: $method — denied by this project's .hermit/forge-policy.json.";
    }

    return null;
}

function policyLiftHint(string $refusal, string $tier, string $method): string
{
    return $refusal . "\nLift with FORGE_POLICY_ALLOW_TIERS=$tier or FORGE_POLICY_ALLOW=$method "
         . "in .env — operator-only; the agent cannot edit .env.";
}

/**
 * The effective policy.
 *
 * The two .env variables are the real boundary: hatch installs an `Edit(.env)`
 * deny into project settings (state-templates/native-permissions.json), so only
 * the operator can widen what is reachable.
 *
 * The project file is NOT a boundary and must not be described as one.
 * Nothing denies edits under `.hermit/`, so an agent can rewrite
 * forge-policy.json to `{"deny": []}` at any time. It exists so an operator can
 * write down "never touch production firewall rules from here" and have the CLI
 * remember it — a note the agent will honour, not a wall it cannot climb.
 *
 * @return array{tiers_lifted: list<string>, methods_lifted: list<string>, project_deny: list<string>, warnings: list<string>}
 */
function loadPolicy(string $projectRoot): array
{
    $warnings = [];

    $split = fn(string $raw) => array_values(array_filter(array_map('trim', explode(',', $raw)), fn($t) => $t !== ''));

    $tiers = [];
    foreach ($split(getenv('FORGE_POLICY_ALLOW_TIERS') ?: '') as $tier) {
        if (in_array($tier, POLICY_TIERS, true)) {
            $tiers[] = $tier;
        } else {
            $warnings[] = "FORGE_POLICY_ALLOW_TIERS: '$tier' is not a tier — ignored. Tiers: " . implode(', ', POLICY_TIERS);
        }
    }

    $methods = [];
    foreach ($split(getenv('FORGE_POLICY_ALLOW') ?: '') as $method) {
        if (isEndpointMethod($method)) {
            $methods[] = $method;
        } else {
            $warnings[] = "FORGE_POLICY_ALLOW: '$method' is not an SDK endpoint method — ignored (typo?).";
        }
    }

    $deny = [];
    $file = rtrim($projectRoot, '/') . '/.hermit/forge-policy.json';
    if (is_file($file)) {
        $parsed = json_decode((string) file_get_contents($file), true);
        if (!is_array($parsed) || !isset($parsed['deny']) || !is_array($parsed['deny'])) {
            $warnings[] = "forge-policy.json is malformed (expected {\"deny\": [...]}) — the whole file was ignored.";
        } else {
            foreach ($parsed['deny'] as $entry) {
                if (!is_string($entry) || $entry === '') continue;
                if (str_ends_with($entry, '*') || isEndpointMethod($entry)) {
                    $deny[] = $entry;
                } else {
                    $warnings[] = "forge-policy.json: '$entry' is not an SDK endpoint method — that entry was dropped.";
                }
            }
        }
    }

    return [
        'tiers_lifted'   => $tiers,
        'methods_lifted' => $methods,
        'project_deny'   => $deny,
        'warnings'       => $warnings,
    ];
}

// ---------------------------------------------------------------------------
// Output scrubber
// ---------------------------------------------------------------------------

/**
 * Best-effort credential redaction for everything printed by call/execute.
 *
 * This is where context hygiene actually belongs. Log-reading methods return
 * free-form strings and were reachable long before the deny tiers existed, so no
 * method-name policy could ever cover them. Redacts to [REDACTED], matching the
 * secret-hygiene vocabulary in CLAUDE-APPEND.
 *
 * Regex redaction, not a parser: it is a strong net, not a proof.
 */
function scrubSecrets(string $text): string
{
    // PEM blocks first — they span lines and would otherwise be partly matched
    // by the base64 rule below.
    $text = preg_replace('/-----BEGIN [^-\n]*-----.*?-----END [^-\n]*-----/s', '[REDACTED]', $text) ?? $text;

    // KEY= / SECRET= / PASSWORD= / *_TOKEN= / CREDENTIAL= assignments, including
    // JSON-ish "key": "value" forms, single-quoted values, and the \" escapes a
    // string gets once printResult JSON-encodes it (a deploy script, an env file).
    // A value ends at \" \n \r \t but runs through \/ \\ \uXXXX, so a JSON-encoded
    // base64 APP_KEY is masked whole.
    $text = preg_replace(
        '/([A-Za-z0-9_.\-]*(?:KEY|SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL)[A-Za-z0-9_.\-]*(?:\\\\?")?\s*[:=]\s*(?:\\\\?["\'])?)(?:[^\s"\'\\\\,]|\\\\[^"nrt\s])+/i',
        '$1[REDACTED]',
        $text
    ) ?? $text;

    // Literal credentials on a `composer config` auth line (a private Satis or
    // Packagist repository). Everything after the host is masked, username included.
    $text = preg_replace(
        '/(composer(?:\.phar)?\s+(?:global\s+)?config\s+(?:-\S+\s+)*(?:http-basic|bearer|github-oauth|gitlab-token|gitlab-oauth|bitbucket-oauth)\.[^\s"\\\\]+)(?:(?:[ \t]|\\\\t)+(?:\\\\?"(?:[^"\\\\\n]|\\\\\\\\\\\\"|\\\\[^"n])*\\\\?"|(?:[^\s"\\\\]|\\\\\\\\\\\\"|\\\\[^"nrt\s])+))+/i',
        '$1 [REDACTED]',
        $text
    ) ?? $text;

    $text = preg_replace('/\bBearer\s+[A-Za-z0-9._\-]{8,}/i', 'Bearer [REDACTED]', $text) ?? $text;

    // Credentials embedded in a connection URL.
    $text = preg_replace('#([a-z][a-z0-9+.\-]*://[^\s:/@]+):[^\s@/]+@#i', '$1:[REDACTED]@', $text) ?? $text;

    // Long high-entropy runs. Mixed case AND a digit is required so a 40-char
    // lowercase git SHA — genuinely useful in a deploy log — survives.
    return preg_replace_callback('#\b[A-Za-z0-9+/]{40,}={0,2}#', function (array $m): string {
        $s = $m[0];
        $mixed = preg_match('/[a-z]/', $s) && preg_match('/[A-Z]/', $s) && preg_match('/\d/', $s);

        return $mixed ? '[REDACTED]' : $s;
    }, $text) ?? $text;
}

/**
 * Keep the SDK summary and the complete validation response, including nested
 * field errors. Scrub after rendering so API-provided details get the same
 * protection as successful output.
 */
function formatSdkError(\Throwable $error): string
{
    $message = 'SDK error: ' . $error->getMessage();
    if ($error instanceof ValidationException && $error->errors() !== []) {
        $message .= "\n" . json_encode($error->errors(), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    }

    return scrubSecrets($message) . "\n";
}

// ---------------------------------------------------------------------------
// Deployment status enums.
// Terminal states are authoritative (deploy-watch keys off isTerminalStatus()
// below). The in-progress set is documentation only — anything not terminal is
// treated as still-running, which keeps the watch robust to undocumented
// states (e.g. 'running', seen in the SDK docs but absent from the OpenAPI enum).
// ---------------------------------------------------------------------------
const STATUS_SUCCESS     = ['finished'];
const STATUS_FAILURE     = ['failed', 'failed-build', 'cancelled'];
const STATUS_IN_PROGRESS = ['pending', 'queued', 'running', 'deploying'];

/** True when a deployment status is terminal (success or failure). */
function isTerminalStatus(string $status): bool
{
    return in_array($status, array_merge(STATUS_SUCCESS, STATUS_FAILURE), true);
}

// ---------------------------------------------------------------------------
// Matchers — resolve a user-supplied query to candidate server/site records.
// Inputs are plain arrays; callers materialize the SDK's CursorPaginator with
// iterator_to_array($paginator->lazy()) before calling these.
// ---------------------------------------------------------------------------
function matchServer(array $servers, string $query): array {
    if (is_numeric($query)) {
        // No fallthrough to name/IP matching for numeric queries (F4).
        return array_values(array_filter($servers, fn($s) => (string)$s->id === $query));
    }
    return array_values(array_filter($servers, function($s) use ($query) {
        return strcasecmp($s->name, $query) === 0 || ($s->ipAddress ?? '') === $query;
    }));
}

// ---------------------------------------------------------------------------
// Translate a server's raw `php_version` (e.g. "php83") into the log key
// Forge expects for its PHP-FPM log (e.g. "php-8.3"). Returns null if the
// input doesn't match the expected `php<major><minor+>` shape.
// ---------------------------------------------------------------------------
function phpLogKey(string $phpVersion): ?string {
    if (!preg_match('/^php(\d)(\d+)$/', $phpVersion, $m)) {
        return null;
    }
    return "php-{$m[1]}.{$m[2]}";
}

function matchSite(array $sites, string $query): array {
    if (is_numeric($query)) {
        return array_values(array_filter($sites, fn($s) => (string)$s->id === $query));
    }
    $queryHost = strtolower(parse_url($query, PHP_URL_HOST) ?: $query);
    return array_values(array_filter($sites, function($s) use ($query, $queryHost) {
        if (strcasecmp($s->name, $query) === 0) return true;
        $siteHost = strtolower(parse_url('https://' . $s->name, PHP_URL_HOST) ?: $s->name);
        if ($siteHost === $queryHost) return true;
        if (isset($s->aliases) && is_array($s->aliases)) {
            foreach ($s->aliases as $alias) {
                if (strcasecmp($alias, $query) === 0) return true;
            }
        }
        return false;
    }));
}
