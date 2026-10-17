#!/usr/bin/env php
<?php
declare(strict_types=1);

// ---------------------------------------------------------------------------
// Bootstrap: project root resolution (port of HA's projectRoot())
// ---------------------------------------------------------------------------
function projectRoot(): string {
    $proj = getenv('CLAUDE_PROJECT_DIR');
    if ($proj !== false && file_exists($proj . '/.hermit')) {
        return $proj;
    }
    $dir = getcwd();
    for ($i = 0; $i < 8; $i++) {
        if (file_exists($dir . '/.hermit/config.json')) {
            return $dir;
        }
        $parent = dirname($dir);
        if ($parent === $dir) break;
        $dir = $parent;
    }
    return getcwd();
}

// ---------------------------------------------------------------------------
// Autoload: project space (prod, hatch-installed) → local dev fallback
// ---------------------------------------------------------------------------
$projectRoot = projectRoot();
$prodAutoload = $projectRoot . '/.hermit/forge-runtime/vendor/autoload.php';
$devAutoload  = __DIR__ . '/vendor/autoload.php';

if (file_exists($prodAutoload)) {
    require_once $prodAutoload;
} elseif (file_exists($devAutoload)) {
    require_once $devAutoload;
} else {
    echo "{\"error\":\"sdk_not_installed:run /hermitd-laravel-forge:hatch\"}\n";
    exit(1);
}

use Laravel\Forge\Forge;
use Laravel\Forge\Exceptions\NotFoundException;

// ---------------------------------------------------------------------------
// .env loader (project root only; getenv() takes precedence)
// ---------------------------------------------------------------------------
function loadEnv(string $root): void {
    $file = $root . '/.env';
    if (!file_exists($file)) return;
    $lines = file($file, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    foreach ($lines as $line) {
        if (str_starts_with(trim($line), '#')) continue;
        if (!str_contains($line, '=')) continue;
        [$key, $val] = explode('=', $line, 2);
        $key = trim($key);
        $val = trim($val, " \t\"'");
        if ($key !== '' && getenv($key) === false) {
            putenv("$key=$val");
        }
    }
}

loadEnv($projectRoot);

// ---------------------------------------------------------------------------
// Token + org resolution
// ---------------------------------------------------------------------------
$token = getenv('FORGE_API_TOKEN') ?: '';
$org   = getenv('FORGE_ORG') ?: '';

// ---------------------------------------------------------------------------
// Shared helpers + constants — one file so the tests exercise the same code
// the CLI ships (see forge-lib.php).
// ---------------------------------------------------------------------------
require_once __DIR__ . '/forge-lib.php';
require_once __DIR__ . '/forge-operation.php';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Print one JSON object on stdout, scrubbed, and exit. Every SDK value reaches
 * the operator's transcript through here, including free-form log strings,
 * which is why the scrubber sits at the output boundary.
 */
function emit(array $data, int $code = 0): never {
    echo json_encode(scrubValue($data), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE) . "\n";
    exit($code);
}

/** A check or write with nothing to report. */
function ok(): never {
    echo "OK\n";
    exit(0);
}

function fail(string $error): never {
    emit(['error' => $error], 1);
}

/** An SDK exception as its `{"error":...}` line (see formatSdkError()). */
function failSdk(\Throwable $e): never {
    echo formatSdkError($e);
    exit(1);
}

function check(bool $cond, string $error): void {
    if (!$cond) fail($error);
}

function requireToken(string $token): void {
    check($token !== '', 'missing_env:FORGE_API_TOKEN');
}

function requireOrg(string $org, Forge $forge): string {
    if ($org !== '') return $org;
    // Attempt to discover org from the API — only valid if there is exactly one.
    // organizations() is a CursorPaginator; materialize all pages so count()
    // reflects the true total, not just page 1.
    try {
        $orgs = iterator_to_array($forge->organizations()->lazy());
    } catch (\Throwable $e) {
        failSdk($e);
    }
    $count = count($orgs);
    if ($count === 1) return $orgs[0]->slug;
    check($count > 0, 'no_organizations');
    // Several orgs: the operator sets FORGE_ORG in .env to one of the slugs.
    emit(['status' => 'ambiguous', 'reason' => 'forge_org_unset',
        'choices' => array_map(fn($o) => ['slug' => $o->slug, 'name' => $o->name], $orgs)]);
}

function serverRow(object $s): array {
    return ['id' => $s->id, 'name' => $s->name, 'ip_address' => $s->ipAddress];
}

function siteRow(object $s): array {
    return ['id' => $s->id, 'name' => $s->name];
}

/** No match or several matches end the command with the candidates to choose from. */
function resolveServer(Forge $forge, string $org, string $serverQuery): object {
    // servers() returns a CursorPaginator — materialize all pages to a plain
    // array so name/IP resolution sees the full estate, not just page 1.
    $servers = iterator_to_array($forge->servers($org)->lazy());
    $candidates = matchServer($servers, $serverQuery);
    if (count($candidates) === 0) {
        emit(['status' => 'no_match', 'reason' => 'server', 'choices' => array_map('serverRow', $servers)]);
    }
    if (count($candidates) > 1) {
        emit(['status' => 'ambiguous', 'reason' => 'server', 'choices' => array_map('serverRow', $candidates)]);
    }
    return $candidates[0];
}

function resolveSite(Forge $forge, string $org, object $server, string $siteQuery): object {
    // serverSites() returns a CursorPaginator — materialize all pages first.
    $sites = iterator_to_array($forge->serverSites($org, $server->id)->lazy());
    $candidates = matchSite($sites, $siteQuery);
    if (count($candidates) === 0) {
        emit(['status' => 'no_match', 'reason' => 'site', 'choices' => array_map('siteRow', $sites)]);
    }
    if (count($candidates) > 1) {
        emit(['status' => 'ambiguous', 'reason' => 'site', 'choices' => array_map('siteRow', $candidates)]);
    }
    return $candidates[0];
}

/** Print an SDK return value as `{"result": ...}`, or bare `OK` when the call returns nothing. */
function printResult(mixed $result): never {
    // A CursorPaginator iterates page 1 only; ->lazy() walks every page, which is
    // what the curated read commands already do. Without this a `call servers` on
    // an estate larger than one page silently reports a truncated list.
    if ($result instanceof \Laravel\Forge\CursorPaginator) {
        $result = $result->lazy();
    }
    if ($result === null) ok();
    if (is_iterable($result)) {
        $rows = [];
        foreach ($result as $item) {
            $rows[] = is_object($item) && method_exists($item, 'toArray') ? $item->toArray() : (array) $item;
        }
        $result = $rows;
    } elseif (is_object($result)) {
        $result = method_exists($result, 'toArray') ? $result->toArray() : (array) $result;
    }
    emit(['result' => $result]);
}

/**
 * The method's real parameter list, minus the org slug (which generic dispatch
 * prepends). Printed on an argument mismatch so a caller can correct its JSON
 * without going and reading the vendored SDK.
 */
function signatureHint(string $method): string {
    $params = (new \ReflectionMethod(Forge::class, $method))->getParameters();
    if (takesOrgFirst($method)) {
        array_shift($params);   // the org slug is not part of the stdin array
    }
    $shown = array_map(function (\ReflectionParameter $p): string {
        $type = $p->getType() instanceof \ReflectionNamedType ? $p->getType()->getName() : 'mixed';
        return $type . ' $' . $p->getName() . ($p->isOptional() ? ' (optional)' : '');
    }, $params);

    return 'expected stdin [' . implode(', ', $shown) . '] without the org slug';
}

/**
 * Read the JSON argument array from stdin.
 *
 * Whitespace-only stdin means "no arguments", not an error — `echo | forge.php
 * call servers` sends a bare newline, and a caller who piped nothing meant to
 * pass nothing. A method that genuinely needed an argument then fails at the
 * capture with signatureHint(), which is a more useful message than a complaint
 * about stdin.
 */
function stdinArgs(): array {
    $stdin = stream_get_contents(STDIN);
    $decoded = ($stdin !== false && trim($stdin) !== '') ? json_decode(trim($stdin), true) : [];
    if (!is_array($decoded)) {
        // Catches both decode failure (null) and valid-but-non-array JSON
        // (a bare string/number would crash the ...spread at the call site).
        fail('invalid_args:stdin must be a JSON array, e.g. [12]');
    }
    return $decoded;
}

// An SDK exception a command does not handle itself still ends as one error line.
set_exception_handler('failSdk');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
$args = array_slice($argv, 1);
$cmd  = array_shift($args) ?? '';

$positional = array_values(array_filter($args, fn($a) => !str_starts_with($a, '--')));

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------
if ($cmd === '' || $cmd === '--help' || $cmd === 'help') {
    $ttl = intdiv(PLAN_TTL_SECONDS, 60);
    echo <<<USAGE
    Usage: forge.php <command> [args]

    Credential:
      check                       Report token status (missing/invalid/unreachable/ok)

    Read commands:
      servers                     List all servers
      server <server>             Show server detail
      sites <server>              List sites on a server
      site <server> <site>        Show site detail
      logs <server> <site>        Show latest deployment log for a site
      server-log <server> <key>   Read a server log by key (keys are hyphenated: nginx-error, nginx-access; 'php' auto-resolves to php-<major>.<minor>)
      site-log <server> <site> <type>  Read a site log (type: application, nginx-access, nginx-error)
      background-process-log <server> <process-id>  Fetch a background process's log output
      deploy-history <server> <site>          List recent deployments
      deploy-log <server> <site> <deploy-id>  Fetch a specific deployment log
      deploy-status <server-id> <site-id> <deploy-id>  Print a deployment's status (raw IDs)
      deploy-watch <server-id> <site-id> <deploy-id>   Poll a deployment until terminal; emits a single TERMINAL line

    Preview commands (read-only, never mutate):
      preview-deploy <server> <site>  Show canonical target before deploying
      preview-reboot <server>         Show canonical target before rebooting

    Write commands (native approval):
      deploy <server> <site>      Trigger deployment (fire-and-return; watch via deploy-watch)
      server-reboot <server>      Reboot server

    Estate scan:
      failed-deploys              Find sites with a failed latest deployment

    Generic dispatch (JSON args on stdin, org slug prepended automatically):
      policy                      Show what is reachable and what is denied (no credentials needed)
      call <sdk-method>           Any SDK read the policy allows
      preview <sdk-method>        Capture the exact request a write would send, store a single-use plan
      execute <plan-id>           Run an operator-approved plan, if it still hashes to what was approved

    A write is never executed from a flag. `preview` shows the real HTTP request and
    stores it under a hash; `execute` re-derives that request and refuses unless it
    still matches. Plans are single use and expire after {$ttl} minutes.

    USAGE;
    exit(0);
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------
if ($cmd === 'check') {
    // Report any active policy lift alongside the credential state, so the hatch
    // and the doctor can see that this install has widened its own reach.
    $lifts = loadPolicy($projectRoot);
    $lift = $lifts['tiers_lifted'] !== [] || $lifts['methods_lifted'] !== []
        ? ['policy_lift' => ['tiers' => $lifts['tiers_lifted'], 'methods' => $lifts['methods_lifted']]]
        : [];

    if ($token === '') {
        emit(['status' => 'missing'] + $lift);
    }
    try {
        $forge = new Forge($token);
        $forge->organizations();
        $status = 'ok';
    } catch (\Throwable $e) {
        $msg = $e->getMessage();
        if (str_contains($msg, '401') || str_contains($msg, 'Unauthorized') || str_contains($msg, 'unauthenticated')) {
            $status = 'invalid';
        } else {
            $status = 'unreachable'; // network/egress error, not an auth rejection
        }
    }
    emit(['status' => $status] + $lift);
}

// ---------------------------------------------------------------------------
// policy  (no credentials, no network — the whole point is that an agent can
// read the boundary it is operating under before it tries anything)
// ---------------------------------------------------------------------------
if ($cmd === 'policy') {
    $policy = loadPolicy($projectRoot);

    $reachable = count(array_filter(
        array_map(fn($m) => $m->getName(), (new \ReflectionClass(Forge::class))->getMethods(\ReflectionMethod::IS_PUBLIC)),
        'isEndpointMethod'
    ));

    $state = fn(string $tier) => in_array($tier, $policy['tiers_lifted'], true) ? 'lifted' : 'denied';

    emit([
        'reachable' => $reachable,
        'tiers' => [
            'secrets' => [
                'state' => $state('secrets'),
                'methods' => SECRET_METHODS,
                'return_types' => array_map(fn($t) => substr((string) strrchr($t, '\\'), 1), SECRET_RETURN_TYPES),
            ],
            'destructive' => ['state' => $state('destructive'), 'verbs' => DESTRUCTIVE_VERBS],
        ],
        'env_lifts' => ['tiers' => $policy['tiers_lifted'], 'methods' => $policy['methods_lifted']],
        'project_deny' => $policy['project_deny'],
        'warnings' => $policy['warnings'],
    ]);
}

// All other commands require a valid token.
requireToken($token);
$forge = new Forge($token);

// Org resolution can cost an API call, and 19 endpoint methods take no org slug
// at all, so it stays lazy for generic dispatch. `execute` never needs it: the
// plan froze the full argument list at preview time.
$resolveOrg = function () use (&$org, $forge): string {
    return $org = requireOrg($org, $forge);
};

// ---------------------------------------------------------------------------
// call <method>     generic read dispatch
// preview <method>  capture the exact request a write would send, store a plan
//
// Both start the same way: resolve the method, capture what it WOULD send
// without sending it, and apply the policy to that captured request. Nothing
// here predicts what a method does — the transport already knows.
// ---------------------------------------------------------------------------
if ($cmd === 'call' || $cmd === 'preview') {
    $method = $positional[0] ?? '';
    check($method !== '', "usage:forge.php $cmd <method>");
    check(isEndpointMethod($method), "not_an_operation:$method");

    $callArgs = stdinArgs();
    if (takesOrgFirst($method)) {
        array_unshift($callArgs, $resolveOrg());
    }

    try {
        $captured = captureRequest($method, $callArgs);
    } catch (\TypeError $e) {
        // With 271 methods reachable, a wrong argument shape is the likely
        // mistake — print the real signature instead of an SDK stack trace.
        fail("argument_mismatch:" . signatureHint($method));
    }

    $isRead = $captured->getMethod() === 'GET';
    check($cmd !== 'call' || $isRead, "not_a_read:use forge.php preview $method");
    check($cmd !== 'preview' || !$isRead, "not_a_write:use forge.php call $method");

    $refusal = policyRefusal($method, $captured, loadPolicy($projectRoot));
    if ($refusal !== null) {
        emit(['status' => 'denied'] + $refusal);
    }

    if ($cmd === 'call') {
        printResult($forge->$method(...$callArgs));
    }

    // --- preview: show the operator the real request, then store it under a hash
    $path = canonicalPath($captured);
    $preview = ['method' => $method, 'verb' => $captured->getMethod(), 'path' => $path];

    // The canonical target comes from the CAPTURED URI, so it is right for every
    // method rather than for the ones whose signature we happened to know.
    //
    // This lookup is decoration, not the preview: the request is already captured
    // and its id is printed with it. resolveServer() exits on a miss and
    // lets SDK errors escape, so it is deliberately NOT reused here — an expired
    // token, a rate limit or a server absent from the listing must not abort a
    // preview.
    if (preg_match('#/servers/(\d+)#', $path, $m) === 1) {
        try {
            $match = matchServer(iterator_to_array($forge->servers($resolveOrg())->lazy()), $m[1]);
            if ($match !== []) $preview['server'] = serverRow($match[0]);
        } catch (\Throwable $e) {
            fwrite(STDERR, "Note: could not resolve server {$m[1]} for display: {$e->getMessage()}\n");
        }
    }

    $body = (string) $captured->getBody();
    if ($body !== '') {
        $preview['body'] = json_decode($body, true) ?? $body;
    }

    $stateDir = $projectRoot . '/.hermit';
    purgeExpiredPlans($stateDir);
    $planId = storePlan($stateDir, [
        'method' => $method,
        'args'   => $callArgs,
        'verb'   => $captured->getMethod(),
        'path'   => $path,
        'body'   => $body,
        'hash'   => planHash($captured),
    ]);

    $preview = ['plan_id' => $planId, 'expires_at' => gmdate('c', time() + PLAN_TTL_SECONDS)] + $preview;
    emit($preview);
}

// ---------------------------------------------------------------------------
// execute <plan-id>
//
// The only path that mutates through generic dispatch. It re-derives the request
// from the stored plan and refuses unless it still hashes to what was approved,
// so an edited payload, an expired window, or a reused plan sends nothing.
// ---------------------------------------------------------------------------
if ($cmd === 'execute') {
    $planId = $positional[0] ?? '';
    check($planId !== '', 'usage:forge.php execute <plan-id>');

    try {
        $result = executePlan($projectRoot . '/.hermit', $planId, $forge, loadPolicy($projectRoot));
    } catch (PlanRefusal $e) {
        emit($e->denial !== null ? ['status' => 'denied'] + $e->denial : ['status' => 'refused', 'reason' => $e->reason]);
    }
    printResult($result);
}

// Everything below this line is a curated command, and all of them are
// org-scoped, so the lazy resolution above is settled once here.
$resolveOrg();

// ---------------------------------------------------------------------------
// servers
// ---------------------------------------------------------------------------
if ($cmd === 'servers') {
    emit(['servers' => array_map('serverRow', iterator_to_array($forge->servers($org)->lazy()))]);
}

// ---------------------------------------------------------------------------
// server <id>
// ---------------------------------------------------------------------------
if ($cmd === 'server') {
    check(isset($positional[0]), 'usage:forge.php server <server>');
    $server = resolveServer($forge, $org, $positional[0]);
    emit(['server' => (array)$server]);
}

// ---------------------------------------------------------------------------
// sites <server>
// ---------------------------------------------------------------------------
if ($cmd === 'sites') {
    check(isset($positional[0]), 'usage:forge.php sites <server>');
    $server = resolveServer($forge, $org, $positional[0]);
    emit(['sites' => array_map('siteRow', iterator_to_array($forge->serverSites($org, $server->id)->lazy()))]);
}

// ---------------------------------------------------------------------------
// site <server> <site>
// ---------------------------------------------------------------------------
if ($cmd === 'site') {
    check(isset($positional[1]), 'usage:forge.php site <server> <site>');
    $server = resolveServer($forge, $org, $positional[0]);
    $site   = resolveSite($forge, $org, $server, $positional[1]);
    emit(['site' => (array)$site]);
}

// ---------------------------------------------------------------------------
// logs <server> <site> [--log-type deploy|site]
// ---------------------------------------------------------------------------
if ($cmd === 'logs') {
    check(isset($positional[1]), 'usage:forge.php logs <server> <site>');
    $server = resolveServer($forge, $org, $positional[0]);
    $site   = resolveSite($forge, $org, $server, $positional[1]);

    // Get the latest deployment and fetch its log.
    $deployments = $forge->deployments($org, $server->id, $site->id);
    $latest = null;
    foreach ($deployments as $d) { $latest = $d; break; }

    if ($latest === null) {
        emit(['status' => 'none', 'reason' => 'no_deployments']);
    }
    emit(['log' => (string) $forge->deploymentLog($org, $server->id, $site->id, $latest->id)]);
}

// ---------------------------------------------------------------------------
// server-log <server> <key>
// ---------------------------------------------------------------------------
if ($cmd === 'server-log') {
    check(isset($positional[1]), 'usage:forge.php server-log <server> <key>');
    $server = resolveServer($forge, $org, $positional[0]);
    $key    = $positional[1];

    if ($key === 'php') {
        $detail   = $forge->server($org, $server->id);
        $resolved = phpLogKey($detail->phpVersion ?? '');
        if ($resolved !== null) {
            $key = $resolved;
        }
    }

    try {
        $log = $forge->serverLog($org, $server->id, $key);
    } catch (NotFoundException $e) {
        // A wrong key, or a service Forge tracks no log path for.
        emit(['status' => 'none', 'reason' => 'no_log', 'log_name' => $key]);
    }
    emit(['log' => (string) $log]);
}

// ---------------------------------------------------------------------------
// site-log <server> <site> <type>
// ---------------------------------------------------------------------------
if ($cmd === 'site-log') {
    check(isset($positional[2]), 'usage:forge.php site-log <server> <site> <application|nginx-access|nginx-error>');

    $methods = [
        'application'  => 'siteApplicationLog',
        'nginx-access' => 'siteNginxAccessLog',
        'nginx-error'  => 'siteNginxErrorLog',
    ];
    $type = $positional[2];
    check(isset($methods[$type]), "usage:log type is one of " . implode(', ', array_keys($methods)));

    $server = resolveServer($forge, $org, $positional[0]);
    $site   = resolveSite($forge, $org, $server, $positional[1]);

    try {
        $log = $forge->{$methods[$type]}($org, $server->id, $site->id);
    } catch (NotFoundException $e) {
        emit(['status' => 'none', 'reason' => 'no_log']);
    }
    emit(['log' => (string) $log]);
}

// ---------------------------------------------------------------------------
// deploy-history <server> <site>
// ---------------------------------------------------------------------------
if ($cmd === 'deploy-history') {
    check(isset($positional[1]), 'usage:forge.php deploy-history <server> <site>');
    $server      = resolveServer($forge, $org, $positional[0]);
    $site        = resolveSite($forge, $org, $server, $positional[1]);
    $rows        = [];
    foreach ($forge->deployments($org, $server->id, $site->id) as $d) {
        $commitMsg = $d->commit->message ?? null;
        $rows[] = ['id' => $d->id, 'status' => $d->status, 'commit' => $commitMsg === null ? null : substr($commitMsg, 0, 60)];
    }
    emit(['deployments' => $rows]);
}

// ---------------------------------------------------------------------------
// deploy-log <server> <site> <deploy-id>
// ---------------------------------------------------------------------------
if ($cmd === 'deploy-log') {
    check(isset($positional[2]), 'usage:forge.php deploy-log <server> <site> <deploy-id>');
    $server   = resolveServer($forge, $org, $positional[0]);
    $site     = resolveSite($forge, $org, $server, $positional[1]);
    $deployId = (int)$positional[2];   // SDK param is int; argv gives a string under strict_types
    emit(['log' => (string) $forge->deploymentLog($org, $server->id, $site->id, $deployId)]);
}

// ---------------------------------------------------------------------------
// background-process-log <server> <process-id>
// ---------------------------------------------------------------------------
if ($cmd === 'background-process-log') {
    check(isset($positional[1]), 'usage:forge.php background-process-log <server> <process-id>');
    $server    = resolveServer($forge, $org, $positional[0]);
    $processId = (int)$positional[1];   // SDK param is int; argv gives a string under strict_types
    try {
        $log = $forge->backgroundProcessLog($org, $server->id, $processId);
    } catch (NotFoundException $e) {
        emit(['status' => 'none', 'reason' => 'no_process']);
    }
    emit(['log' => (string) $log]);
}

// ---------------------------------------------------------------------------
// preview-deploy <server> <site>  (read-only, no hook gate needed)
// ---------------------------------------------------------------------------
if ($cmd === 'preview-deploy') {
    check(isset($positional[1]), 'usage:forge.php preview-deploy <server> <site>');
    $server = resolveServer($forge, $org, $positional[0]);
    $site   = resolveSite($forge, $org, $server, $positional[1]);
    emit(['server' => serverRow($server), 'site' => siteRow($site)]);
}

// ---------------------------------------------------------------------------
// preview-reboot <server>  (read-only)
// ---------------------------------------------------------------------------
if ($cmd === 'preview-reboot') {
    check(isset($positional[0]), 'usage:forge.php preview-reboot <server>');
    emit(['server' => serverRow(resolveServer($forge, $org, $positional[0]))]);
}

// ---------------------------------------------------------------------------
// deploy <server> <site>   (fire-and-return)
//
// Triggers the deployment and returns immediately with the canonical IDs.
// Watching is decoupled: the forge-deploy skill arms a CC Monitor that runs
// `deploy-watch` until terminal, so a long deploy never blocks a foreground
// Bash call (which the tool would kill at its timeout).
// ---------------------------------------------------------------------------
if ($cmd === 'deploy') {
    check(isset($positional[1]), 'usage:forge.php deploy <server> <site>');
    $server = resolveServer($forge, $org, $positional[0]);
    $site   = resolveSite($forge, $org, $server, $positional[1]);

    $deployment = $forge->createDeployment($org, $server->id, $site->id, []);
    emit(['deploy_id' => $deployment->id, 'server_id' => $server->id, 'site_id' => $site->id, 'deploy_status' => $deployment->status]);
}

// ---------------------------------------------------------------------------
// deploy-status <server-id> <site-id> <deploy-id>
//
// Prints just the deployment status. Takes raw numeric IDs (no
// name/IP resolution), so it is a single API call per invocation — cheap
// enough for a Monitor poll loop to call every few seconds.
// ---------------------------------------------------------------------------
if ($cmd === 'deploy-status') {
    check(isset($positional[2]), 'usage:forge.php deploy-status <server-id> <site-id> <deploy-id>');
    [$serverId, $siteId, $deployId] = $positional;
    // SDK params are int; argv gives strings and forge.php is strict_types=1.
    $d = $forge->deployment($org, (int)$serverId, (int)$siteId, (int)$deployId);
    emit(['deploy_status' => $d->status ?? 'unknown']);
}

// ---------------------------------------------------------------------------
// deploy-watch <server-id> <site-id> <deploy-id>
//
// Polls deployment status until terminal or timeout (180 x 5s ~= 15 min),
// echoing only on change. Emits one TERMINAL line and exits 0. The TERMINAL
// line carries only numeric IDs — Forge server names can contain spaces,
// which would break the space-delimited fields.
// ---------------------------------------------------------------------------
if ($cmd === 'deploy-watch') {
    check(isset($positional[2]), 'usage:forge.php deploy-watch <server-id> <site-id> <deploy-id>');
    [$serverId, $siteId, $deployId] = $positional;
    $prev    = null;
    $prevErr = null;
    for ($n = 0; $n < 180; $n++) {
        try {
            $d  = $forge->deployment($org, (int)$serverId, (int)$siteId, (int)$deployId);
            $st = $d->status ?? 'unknown';
        } catch (\Throwable $e) {
            $st = null; // transient API error — keep polling
            // A permanent error (bad IDs, revoked token) would otherwise surface
            // only as an opaque `status=timeout` 15 minutes on. The watcher's
            // notification stream is stdout, so the signal goes there — but as
            // the exception class alone, holding the metadata-only contract
            // (messages can carry response bodies). The message goes to stderr,
            // which reaches the monitor's output file, never a notification.
            if (get_class($e) !== $prevErr) {
                $prevErr = get_class($e);
                echo "deploy {$deployId}: poll error ({$prevErr})\n";
                fwrite(STDERR, "deploy {$deployId}: poll error: {$e->getMessage()}\n");
            }
        }
        if ($st !== null) {
            if ($st !== $prev) {
                echo "deploy {$deployId}: {$st}\n";
            }
            if (isTerminalStatus($st)) {
                echo "TERMINAL deploy={$deployId} server-id={$serverId} site-id={$siteId} status={$st}\n";
                exit(0);
            }
        }
        $prev = $st;
        sleep(5);
    }
    echo "TERMINAL deploy={$deployId} server-id={$serverId} site-id={$siteId} status=timeout\n";
    exit(0);
}

// ---------------------------------------------------------------------------
// server-reboot <server>
// ---------------------------------------------------------------------------
if ($cmd === 'server-reboot') {
    check(isset($positional[0]), 'usage:forge.php server-reboot <server>');
    $server = resolveServer($forge, $org, $positional[0]);
    $forge->createServerAction($org, $server->id, ['action' => 'reboot']);
    ok();
}

// ---------------------------------------------------------------------------
// failed-deploys
// ---------------------------------------------------------------------------
if ($cmd === 'failed-deploys') {
    $failures = [];
    $paceCount = 0;

    try {
        $sites = $forge->organizationSites($org)->lazy();
        foreach ($sites as $site) {
            // Check deployment_status field if available on the site object.
            $status = $site->deploymentStatus ?? $site->deployment_status ?? null;

            if ($status === null) {
                // No eager deployment_status — skip (scope deferred to gating).
                continue;
            }

            if (in_array($status, STATUS_FAILURE, true)) {
                // Fetch detail for this failure.
                $paceCount++;
                if ($paceCount % 10 === 0) {
                    // Conservative pacing: brief pause every 10 detail fetches.
                    sleep(2);
                }
                try {
                    $deployments = $forge->deployments($org, $site->serverId, $site->id);
                    $latest = null;
                    foreach ($deployments as $d) { $latest = $d; break; }

                    $failures[] = [
                        'site_id'    => $site->id,
                        'site_name'  => $site->name,
                        'server_id'  => $site->serverId,
                        'status'     => $status,
                        'deploy_id'  => $latest?->id,
                        'deploy_status' => $latest?->status,
                        'commit'     => $latest?->commit?->message ?? null,
                    ];
                } catch (\Throwable $e) {
                    if (str_contains($e->getMessage(), '429')) {
                        sleep(30);
                    }
                    $failures[] = [
                        'site_id'   => $site->id,
                        'site_name' => $site->name,
                        'server_id' => $site->serverId,
                        'status'    => $status,
                        'error'     => $e->getMessage(),
                    ];
                }
            }
        }
    } catch (\Throwable $e) {
        failSdk($e);   // a 429 here is {"error":"rate_limited:..."}
    }

    emit(['failures' => $failures]);
}

// ---------------------------------------------------------------------------
// Unknown command
// ---------------------------------------------------------------------------
fail("unknown_command:$cmd");
