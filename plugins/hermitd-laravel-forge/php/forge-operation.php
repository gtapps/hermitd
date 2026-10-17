<?php
declare(strict_types=1);

// ---------------------------------------------------------------------------
// The request-bound write gateway.
//
// Claude Code requests native approval before execution. This gateway binds
// execution to the captured request through its hash, expiry, and single use.
// It does not implement a separate CLI confirmation checkpoint.
//
// No CLI parsing and no output formatting live here, so php/tests/run.php can
// drive the whole gateway directly.
// ---------------------------------------------------------------------------

use GuzzleHttp\Client;
use GuzzleHttp\HandlerStack;
use Laravel\Forge\Forge;
use Psr\Http\Message\RequestInterface;

/** How long an approved plan stays executable. */
const PLAN_TTL_SECONDS = 900;

/** Plan ids are generated, never operator-supplied — the shape is enforced so a
 *  plan id can never escape the plan directory. */
const PLAN_ID_PATTERN = '/^fp-[0-9a-f]{8}$/';

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/**
 * Carries the captured request out of the SDK call that produced it.
 *
 * Throwing is the mechanism, not an error path: it aborts the SDK's own request
 * pipeline at the first outbound request, which for every multi-request SDK
 * write (`post` → `retry`) is always the mutation.
 */
final class CaptureComplete extends \Exception
{
    public function __construct(public readonly RequestInterface $request)
    {
        parent::__construct('request captured');
    }
}

/**
 * A gateway refusal. `$reason` is the machine-readable cause; a `policy`
 * refusal also carries the policyRefusal() denial it was built from.
 */
final class PlanRefusal extends \RuntimeException
{
    public function __construct(public readonly string $reason, string $message, public readonly ?array $denial = null)
    {
        parent::__construct($message);
    }
}

/**
 * A Forge client whose terminal handler captures the first outbound request and
 * aborts. There is no handler below it, so there is nothing that could open a
 * socket — "capture never reaches the network" is structural, not a promise.
 *
 * The dummy token is deliberate: capture needs no credential, which is what lets
 * `policy` and `preview` run before the token bootstrap.
 */
function captureClient(): Forge
{
    $handler = function (RequestInterface $req, array $opts) {
        throw new CaptureComplete($req);
    };

    return new Forge('capture', new Client(['handler' => HandlerStack::create($handler)]));
}

/**
 * The exact request `$method` would send, without sending it.
 *
 * @param  list<mixed>  $args  the full argument list, org slug included
 * @throws \RuntimeException when the method issues no HTTP request at all
 */
function captureRequest(string $method, array $args): RequestInterface
{
    try {
        captureClient()->$method(...$args);
    } catch (CaptureComplete $e) {
        return $e->request;
    }

    throw new \RuntimeException("Method '$method' issued no HTTP request.");
}

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

/** The request path with exactly one leading slash. Captured URIs are relative
 *  (the SDK's base_uri lives in client config), so this normalizes both forms. */
function canonicalPath(RequestInterface $r): string
{
    return '/' . ltrim($r->getUri()->getPath(), '/');
}

/**
 * verb \n path \n sorted-query \n raw-body
 *
 * Headers are excluded ON PURPOSE. The real client's Authorization header
 * carries the API token; including it would put the token into every stored plan
 * file and make the hash depend on client configuration rather than on what the
 * request actually does. Host is excluded for the same reason — the path already
 * carries the org, server and site ids that identify the target.
 */
function canonicalRequest(RequestInterface $r): string
{
    return implode("\n", [
        strtoupper($r->getMethod()),
        canonicalPath($r),
        canonicalQuery($r),
        (string) $r->getBody(),
    ]);
}

/**
 * The raw query pairs, sorted — order-independent without being lossy.
 *
 * Deliberately NOT parse_str()/http_build_query(): parse_str rewrites `.` and
 * space in top-level keys to `_` and keeps only the last of a repeated key, so
 * `?a.b=1` and `?a_b=1` would canonicalize — and therefore hash — identically.
 * A hash that binds an approval to one exact request cannot afford a collision.
 */
function canonicalQuery(RequestInterface $r): string
{
    $raw = $r->getUri()->getQuery();
    if ($raw === '') return '';

    $pairs = explode('&', $raw);
    sort($pairs, SORT_STRING);

    return implode('&', $pairs);
}

function planHash(RequestInterface $r): string
{
    return 'sha256:' . hash('sha256', canonicalRequest($r));
}

// ---------------------------------------------------------------------------
// Plan store
//
// Plans live in the hermit state dir, which is gitignored. A plan record can
// contain the request payload — for some methods that means a credential the
// operator supplied. That is a real at-rest surface: it is narrow (0700, one
// file, 15 minutes, deleted on use, expired ones purged on every preview) but it
// is not zero, and the docs say so.
// ---------------------------------------------------------------------------

function planDir(string $stateDir): string
{
    return rtrim($stateDir, '/') . '/state/forge-plans';
}

/**
 * @param  array{method: string, args: list<mixed>, verb: string, path: string, body: string, hash: string}  $plan
 * @return string  the generated plan id
 */
function storePlan(string $stateDir, array $plan): string
{
    $dir = planDir($stateDir);
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
        throw new \RuntimeException("Could not create plan directory: $dir");
    }

    $now = time();
    $id  = 'fp-' . bin2hex(random_bytes(4));

    $record = $plan + [
        'id'         => $id,
        'created_at' => gmdate('c', $now),
        'expires_at' => gmdate('c', $now + PLAN_TTL_SECONDS),
    ];

    $file = "$dir/$id.json";
    if (file_put_contents($file, json_encode($record, JSON_PRETTY_PRINT)) === false) {
        throw new \RuntimeException("Could not write plan: $file");
    }
    @chmod($file, 0600);

    return $id;
}

/**
 * @throws PlanRefusal  reason: malformed | missing | expired
 */
function loadPlan(string $stateDir, string $id): array
{
    if (preg_match(PLAN_ID_PATTERN, $id) !== 1) {
        throw new PlanRefusal('malformed', "'$id' is not a plan id.");
    }

    $file = planDir($stateDir) . "/$id.json";
    if (!is_file($file)) {
        throw new PlanRefusal('missing', "No plan '$id'. It expired, was already used, or never existed — re-run preview.");
    }

    $record = json_decode((string) file_get_contents($file), true);
    $required = ['id', 'method', 'args', 'verb', 'path', 'body', 'hash', 'expires_at'];
    if (!is_array($record) || array_diff($required, array_keys($record)) !== []) {
        throw new PlanRefusal('malformed', "Plan '$id' is unreadable. Re-run preview.");
    }

    if (planIsExpired($record)) {
        throw new PlanRefusal('expired', "Plan '$id' expired at {$record['expires_at']}. Re-run preview to get a fresh one.");
    }

    return $record;
}

function planIsExpired(array $record): bool
{
    $expires = strtotime((string) ($record['expires_at'] ?? ''));

    return $expires === false || $expires < time();
}

/** Deletes expired plan files. Called on every preview, so the payload-at-rest
 *  window is bounded even when a preview is never approved. */
function purgeExpiredPlans(string $stateDir): int
{
    $purged = 0;
    foreach (glob(planDir($stateDir) . '/fp-*.json') ?: [] as $file) {
        $record = json_decode((string) @file_get_contents($file), true);
        if (!is_array($record) || planIsExpired($record)) {
            @unlink($file);
            $purged++;
        }
    }

    return $purged;
}

/**
 * Single use is implemented by deletion, not by a `used` flag: a flag needs an
 * atomic read-modify-write and leaves the payload on disk, while unlinking gives
 * single-use and removes the payload in one step.
 */
function consumePlan(string $stateDir, string $id): void
{
    @unlink(planDir($stateDir) . "/$id.json");
}

// ---------------------------------------------------------------------------
// Hash-checked execution
// ---------------------------------------------------------------------------

/**
 * Executes an approved plan, or refuses. Every refusal path returns before the
 * real client is touched, so no refusal can reach the network.
 *
 * `$policy` is re-applied to the RE-CAPTURED request, not just at preview time:
 * a tier the operator lifted in .env to authorise one preview must not stay
 * lifted for a plan that is executed after they took it away again.
 *
 * @throws PlanRefusal  reason: malformed | missing | expired | mismatch | policy
 */
function executePlan(string $stateDir, string $id, Forge $real, ?array $policy = null): mixed
{
    $plan = loadPlan($stateDir, $id);

    $method = (string) $plan['method'];
    $args   = (array) $plan['args'];

    // Re-derive the request from the stored invocation and compare. This is what
    // binds the approval to one exact request: a plan file edited after approval,
    // or an SDK whose transformation of the same arguments has changed, no longer
    // hashes to what the operator saw.
    $recaptured = captureRequest($method, $args);
    if (!hash_equals((string) $plan['hash'], planHash($recaptured))) {
        throw new PlanRefusal('mismatch',
            "Plan '$id' no longer matches the request it approved. Nothing was sent. Re-run preview.");
    }

    if ($policy !== null && ($refusal = policyRefusal($method, $recaptured, $policy)) !== null) {
        throw new PlanRefusal('policy', "Plan '$id' is denied by policy ({$refusal['reason']}). Nothing was sent.", $refusal);
    }

    consumePlan($stateDir, $id);

    return $real->$method(...$args);
}
