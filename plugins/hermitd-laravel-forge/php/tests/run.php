#!/usr/bin/env php
<?php
declare(strict_types=1);

// Dependency-free PHP test harness for forge.php
//
// Uses an explicit check() helper — NOT PHP's assert(), which is a no-op when
// zend.assertions=-1 (the production php.ini default).
//
// Requires a vendor tree at php/vendor/ (run `composer install --working-dir=php`
// before this script). In CI: `composer install --no-dev --working-dir=php`.

$vendorAutoload = __DIR__ . '/../vendor/autoload.php';
if (!file_exists($vendorAutoload)) {
    fwrite(STDERR, "vendor/autoload.php not found. Run: composer install --working-dir=php/\n");
    exit(1);
}
require_once $vendorAutoload;

// Test against the shipped code, not a re-implementation.
require_once __DIR__ . '/../forge-lib.php';
require_once __DIR__ . '/../forge-operation.php';

use GuzzleHttp\Client;
use GuzzleHttp\Handler\MockHandler;
use GuzzleHttp\HandlerStack;
use GuzzleHttp\Psr7\Request;
use GuzzleHttp\Psr7\Response;
use Laravel\Forge\Forge;

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
$passed = 0;
$failed = 0;

function check(bool $cond, string $msg): void {
    global $passed, $failed;
    if ($cond) {
        echo "  ✓ $msg\n";
        $passed++;
    } else {
        fwrite(STDERR, "  ✗ $msg\n");
        $failed++;
    }
}

// ---------------------------------------------------------------------------
// Helper: make a Forge instance backed by a MockHandler
// ---------------------------------------------------------------------------
function makeMockForge(array $responses): array {
    $mock    = new MockHandler($responses);
    $stack   = HandlerStack::create($mock);
    // Match the SDK's default transport so it maps HTTP errors to SDK exceptions.
    $guzzle  = new Client(['handler' => $stack, 'http_errors' => false]);
    $forge   = new Forge('test-token', $guzzle);
    return [$forge, $mock];
}

function fakeServer(int $id, string $name, string $ip): object {
    return (object)['id' => $id, 'name' => $name, 'ipAddress' => $ip];
}

function fakeSite(int $id, string $name, array $aliases = []): object {
    return (object)['id' => $id, 'name' => $name, 'aliases' => $aliases];
}

const MONITOR_PAYLOAD = ['type' => 'cpu_load', 'operator' => 'gte', 'threshold' => 90, 'notify' => 'a@b.c'];

// ---------------------------------------------------------------------------
// Block A — capture exactness
//
// This block comes first on purpose. Every other guarantee in the plan gateway
// (policy applied to the real verb, a hash that binds an approval to one exact
// request) is decorative if the captured request is not what the SDK would
// really have sent. There is no downstream handler to send to: the capture
// closure IS the terminal handler of the stack, so nothing below it exists.
// ---------------------------------------------------------------------------
echo "\nBlock A — capture exactness:\n";

$req = captureRequest('createMonitor', ['acme', 12, MONITOR_PAYLOAD]);
check($req->getMethod() === 'POST', 'createMonitor captures verb POST');
check(canonicalPath($req) === '/orgs/acme/servers/12/monitors',
    'createMonitor captures the real path (got: ' . canonicalPath($req) . ')');
check((string) $req->getBody() === json_encode(MONITOR_PAYLOAD),
    'captured body is the exact wire JSON');

// The SDK wraps a plain string argument into a keyed object. A preview built
// from CLI args instead of the wire body would show 'FOO=bar' and hash it —
// this is the case that killed the guessed-payload design.
$env = captureRequest('updateSiteEnvironment', ['acme', 12, 34, 'FOO=bar']);
check((string) $env->getBody() === '{"environment":"FOO=bar"}',
    'updateSiteEnvironment body is SDK-transformed, not the raw arg');

// createServer is post → retry: two requests. Capture must abort at the first,
// which is always the mutation (verified across every multi-request SDK write).
$srv = captureRequest('createServer', ['acme', ['name' => 'web-1']]);
check($srv->getMethod() === 'POST', 'multi-request write captures the mutation, not the poll');

$threw = false;
try {
    captureRequest('getTimeout', []);
} catch (\RuntimeException $e) {
    $threw = true;
}
check($threw, 'a method that issues no request throws RuntimeException');

// ---------------------------------------------------------------------------
// Block B — canonicalization and hash
//
// The canonical string deliberately excludes host and ALL headers: the real
// client's Authorization header carries the API token, and hashing it would put
// the token in every stored plan file.
// ---------------------------------------------------------------------------
echo "\nBlock B — canonicalization and hash:\n";

$canon = canonicalRequest($req);
check(!str_contains($canon, 'Authorization'), 'canonical string carries no Authorization header');
check(!str_contains($canon, 'forge.laravel.com'), 'canonical string carries no host');
check(str_starts_with($canon, "POST\n/orgs/acme/servers/12/monitors\n"), 'canonical string starts verb then path');

check(planHash(new Request('GET', 'https://x/y?b=2&a=1')) === planHash(new Request('GET', 'https://x/y?a=1&b=2')),
    'query param order does not change the hash');
check(planHash(new Request('GET', 'https://x/y')) !== planHash(new Request('GET', 'https://x/z')),
    'a different path changes the hash');

$mutated = MONITOR_PAYLOAD;
$mutated['threshold'] = 91;
check(planHash($req) !== planHash(captureRequest('createMonitor', ['acme', 12, $mutated])),
    'one changed payload byte changes the hash');
check(planHash($req) === planHash(captureRequest('createMonitor', ['acme', 12, MONITOR_PAYLOAD])),
    'two independent captures of identical args hash identically');

// ---------------------------------------------------------------------------
// Block C — plan lifecycle
//
// Every refusal below must happen before the real client is touched. The
// mock Forge is given TWO queued responses and each refusal asserts that both
// are still queued: a refusal that leaked a request would consume one.
// ---------------------------------------------------------------------------
echo "\nBlock C — plan lifecycle:\n";

$tmpState = sys_get_temp_dir() . '/forge-plan-test-' . getmypid();

function planFor(string $stateDir, array $args): string {
    $r = captureRequest('createMonitor', $args);
    return storePlan($stateDir, [
        'method' => 'createMonitor',
        'args'   => $args,
        'verb'   => $r->getMethod(),
        'path'   => canonicalPath($r),
        'body'   => (string) $r->getBody(),
        'hash'   => planHash($r),
    ]);
}

function monitorResponses(): array {
    $body = json_encode(['data' => ['id' => 7, 'type' => 'cpu_load']]);
    return [new Response(200, [], $body), new Response(200, [], $body)];
}

/** @return array{string,int} refusal reason and how many mock responses were left untouched */
function refusalOf(string $stateDir, string $id): array {
    [$forge, $mock] = makeMockForge(monitorResponses());
    try {
        executePlan($stateDir, $id, $forge);
        return ['none', $mock->count()];
    } catch (PlanRefusal $e) {
        return [$e->reason, $mock->count()];
    }
}

$planId = planFor($tmpState, ['acme', 12, MONITOR_PAYLOAD]);
check(preg_match(PLAN_ID_PATTERN, $planId) === 1, "storePlan returns a well-formed id ($planId)");

$loaded = loadPlan($tmpState, $planId);
check($loaded['method'] === 'createMonitor', 'plan round-trips the method');
check($loaded['args'] === ['acme', 12, MONITOR_PAYLOAD], 'plan round-trips the exact args');
check($loaded['verb'] === 'POST' && $loaded['path'] === '/orgs/acme/servers/12/monitors',
    'plan round-trips the captured verb and path');
check($loaded['body'] === json_encode(MONITOR_PAYLOAD), 'plan round-trips the wire body');
check($loaded['hash'] === planHash(captureRequest('createMonitor', ['acme', 12, MONITOR_PAYLOAD])),
    'stored hash matches a fresh capture of the same args');

[$reason, $left] = refusalOf($tmpState, 'fp-deadbeef');
check($reason === 'missing' && $left === 2, 'unknown plan id refuses as missing, sends nothing');

[$reason, $left] = refusalOf($tmpState, '../../../etc/passwd');
check($reason === 'malformed' && $left === 2, 'a plan id that is a path refuses as malformed, sends nothing');

file_put_contents(planDir($tmpState) . '/fp-11111111.json', 'not json');
[$reason, $left] = refusalOf($tmpState, 'fp-11111111');
check($reason === 'malformed' && $left === 2, 'unparseable plan refuses as malformed, sends nothing');

// Expire a live plan by rewriting only its expiry.
$expiredId = planFor($tmpState, ['acme', 12, MONITOR_PAYLOAD]);
$expiredFile = planDir($tmpState) . "/$expiredId.json";
$rec = json_decode((string) file_get_contents($expiredFile), true);
$rec['expires_at'] = gmdate('c', time() - 1);
file_put_contents($expiredFile, json_encode($rec));
[$reason, $left] = refusalOf($tmpState, $expiredId);
check($reason === 'expired' && $left === 2, 'expired plan refuses, sends nothing');

// The attack the hash exists to stop: the approved plan is edited to carry a
// different payload after the operator approved what they were shown.
$tamperedId = planFor($tmpState, ['acme', 12, MONITOR_PAYLOAD]);
$tamperedFile = planDir($tmpState) . "/$tamperedId.json";
$rec = json_decode((string) file_get_contents($tamperedFile), true);
$rec['args'][2]['threshold'] = 5;
file_put_contents($tamperedFile, json_encode($rec));
[$reason, $left] = refusalOf($tmpState, $tamperedId);
check($reason === 'mismatch' && $left === 2, 'payload edited after approval refuses as mismatch, sends nothing');

// Happy path.
[$forge, $mock] = makeMockForge(monitorResponses());
executePlan($tmpState, $planId, $forge);
check($mock->count() === 1, 'an approved plan forwards exactly one request');
check(!file_exists(planDir($tmpState) . "/$planId.json"), 'the plan file is gone after execution');

[$reason, $left] = refusalOf($tmpState, $planId);
check($reason === 'missing' && $left === 2, 'a plan cannot be executed twice (single use by deletion)');

$liveId = planFor($tmpState, ['acme', 12, MONITOR_PAYLOAD]);
$purged = purgeExpiredPlans($tmpState);
check($purged >= 2, "purge removes expired and malformed plans (removed $purged)");
check(file_exists(planDir($tmpState) . "/$liveId.json"), 'purge keeps live plans');

// Cleanup — no rm -rf (blocked by the base hermit deny-pattern hook).
foreach (glob(planDir($tmpState) . '/*') ?: [] as $f) { unlink($f); }
@rmdir(planDir($tmpState));
@rmdir($tmpState . '/state');
@rmdir($tmpState);

// ---------------------------------------------------------------------------
// Tests: matchServer
// ---------------------------------------------------------------------------
echo "\nmatchServer:\n";
$servers = [fakeServer(1, 'prod-web', '10.0.0.1'), fakeServer(2, 'prod-db', '10.0.0.2'), fakeServer(3, 'prod-web', '10.0.0.3')];

$result = matchServer($servers, 'prod-db');
check(count($result) === 1 && $result[0]->id === 2, 'name match returns single result');

$result = matchServer($servers, '10.0.0.1');
check(count($result) === 1 && $result[0]->id === 1, 'IP match');

$result = matchServer($servers, '1');
check(count($result) === 1 && $result[0]->id === 1, 'numeric ID match');

$result = matchServer($servers, 'prod-web');
check(count($result) === 2, 'duplicate name returns multiple candidates (ambiguity rejection test data)');

// ---------------------------------------------------------------------------
// Tests: phpLogKey
// ---------------------------------------------------------------------------
echo "\nphpLogKey:\n";
check(phpLogKey('php83') === 'php-8.3', "php83 -> php-8.3");
check(phpLogKey('php810') === 'php-8.10', "php810 -> php-8.10 (multi-digit minor)");
check(phpLogKey('nonsense') === null, "non-matching input returns null");

// ---------------------------------------------------------------------------
// Tests: isTerminalStatus (the binding deploy-watch relies on)
// ---------------------------------------------------------------------------
echo "\nisTerminalStatus:\n";
foreach (STATUS_SUCCESS as $s) {
    check(isTerminalStatus($s) === true, "success status '$s' is terminal");
}
foreach (STATUS_FAILURE as $s) {
    check(isTerminalStatus($s) === true, "failure status '$s' is terminal");
}
foreach (STATUS_IN_PROGRESS as $s) {
    check(isTerminalStatus($s) === false, "in-progress status '$s' is not terminal");
}
check(isTerminalStatus('unknown') === false, "unrecognized status 'unknown' is not terminal");

// ---------------------------------------------------------------------------
// Tests: matchSite
// ---------------------------------------------------------------------------
echo "\nmatchSite:\n";
$sites = [
    fakeSite(10, 'myapp.com', ['www.myapp.com']),
    fakeSite(11, 'api.myapp.com'),
    fakeSite(12, 'myapp.com'),   // duplicate name
];

$result = matchSite($sites, 'myapp.com');
check(count($result) === 2, 'duplicate name → multiple candidates');

$result = matchSite($sites, 'api.myapp.com');
check(count($result) === 1 && $result[0]->id === 11, 'exact name match');

$result = matchSite($sites, 'www.myapp.com');
check(count($result) === 1 && $result[0]->id === 10, 'alias match');

$result = matchSite($sites, '10');
check(count($result) === 1 && $result[0]->id === 10, 'numeric ID match');

$result = matchSite($sites, 'https://api.myapp.com/path');
check(count($result) === 1 && $result[0]->id === 11, 'URL hostname match');

// ---------------------------------------------------------------------------
// Block D — derived predicates
// ---------------------------------------------------------------------------
echo "\nBlock D — derived predicates:\n";

check(isEndpointMethod('createMonitor'), 'createMonitor is an endpoint method');

// The 11 public non-endpoint names. setApiKey can swap the auth header; the six
// transports bypass the named-method model entirely.
$nonEndpoint = ['__construct', 'transformCollection', 'setApiKey', 'setTimeout', 'getTimeout',
                'get', 'post', 'put', 'patch', 'delete', 'retry'];
$leaked = array_values(array_filter($nonEndpoint, 'isEndpointMethod'));
check($leaked === [], 'no non-endpoint public method classifies as an endpoint'
    . ($leaked === [] ? '' : ' (leaked: ' . implode(', ', $leaked) . ')'));
check(!isEndpointMethod('noSuchMethodAnywhere'), 'an unknown name is not an endpoint method');

check(takesOrgFirst('createMonitor'), 'createMonitor takes the org slug first');
check(!takesOrgFirst('createForgeRecipeRun'), 'createForgeRecipeRun takes no org slug');

// ---------------------------------------------------------------------------
// Block E — policy matrix
// ---------------------------------------------------------------------------
echo "\nBlock E — policy matrix:\n";

function emptyPolicy(array $over = []): array {
    return $over + ['tiers_lifted' => [], 'methods_lifted' => [], 'project_deny' => [], 'warnings' => []];
}

/** Runs the real gate: capture the request, then apply the policy to it. */
function refusalFor(string $method, array $args, ?array $policy = null): ?string {
    return policyRefusal($method, captureRequest($method, $args), $policy ?? emptyPolicy());
}

check(refusalFor('siteEnvironment', ['acme', 12, 34]) !== null, 'siteEnvironment denied by name (secrets)');
check(refusalFor('deploymentTriggerUrl', ['acme', 12, 34]) !== null, 'deploymentTriggerUrl denied by name (secrets)');
check(refusalFor('composerCredentials', ['acme', 12, 34]) !== null, 'composerCredentials denied by glob (secrets)');
check(refusalFor('composerCredential', ['acme', 12, 34, 'repo']) !== null, 'composerCredential denied by glob (secrets)');
check(refusalFor('teamServerCredentials', ['acme', 3]) !== null, 'teamServerCredentials denied by name (secrets)');

// Explicit regression against over-blocking. All three are public or
// metadata-only per the SDK's own docblocks and field lists; an earlier draft
// denied them and would have broken real read workflows for nothing.
check(refusalFor('serverKey', ['acme', 12]) === null, 'serverKey ALLOWED (docblock: "public SSH key")');
check(refusalFor('deployKey', ['acme', 12, 34]) === null, 'deployKey ALLOWED (DeployKey::$key is "the public deploy key")');
check(refusalFor('storageProviders', ['acme']) === null, 'storageProviders ALLOWED (13 metadata fields, zero credentials)');

// Regression against the name-pattern hole: these issue DELETE with no `delete` prefix.
check(refusalFor('disableQuickDeploy', ['acme', 12, 34]) !== null, 'disableQuickDeploy denied via captured DELETE');
check(refusalFor('disablePushToDeploy', ['acme', 12, 34]) !== null, 'disablePushToDeploy denied via captured DELETE');
check(refusalFor('deleteServer', ['acme', 12]) !== null, 'deleteServer denied (destructive)');

$refusal = refusalFor('deleteServer', ['acme', 12]);
check(str_contains((string) $refusal, "tier 'destructive'") && str_contains((string) $refusal, 'FORGE_POLICY_ALLOW_TIERS'),
    'a tier refusal names both the tier and how to lift it');

check(refusalFor('deleteServer', ['acme', 12], emptyPolicy(['tiers_lifted' => ['destructive']])) === null,
    'destructive lifts with FORGE_POLICY_ALLOW_TIERS=destructive');
check(refusalFor('deleteServer', ['acme', 12], emptyPolicy(['methods_lifted' => ['deleteServer']])) === null,
    'destructive lifts for one named method with FORGE_POLICY_ALLOW');
check(refusalFor('deleteMonitor', ['acme', 12, 5], emptyPolicy(['methods_lifted' => ['deleteServer']])) !== null,
    'a per-method lift does not leak to a sibling method');
check(refusalFor('siteEnvironment', ['acme', 12, 34], emptyPolicy(['tiers_lifted' => ['secrets']])) === null,
    'secrets lifts with FORGE_POLICY_ALLOW_TIERS=secrets');

check(refusalFor('monitors', ['acme', 12], emptyPolicy(['project_deny' => ['monitors']])) !== null,
    'the project deny file refuses a method the tiers allow');
check(refusalFor('monitors', ['acme', 12], emptyPolicy(['project_deny' => ['monitor*']])) !== null,
    'project deny entries accept a trailing-* glob');

// Non-endpoint methods are structural refusals: naming them in the project file
// and BOTH env variables must not make them reachable.
$everythingLifted = emptyPolicy([
    'tiers_lifted'   => POLICY_TIERS,
    'methods_lifted' => ['setApiKey', 'post'],
    'project_deny'   => [],
]);
check(policyRefusal('setApiKey', new Request('GET', '/x'), $everythingLifted) !== null,
    'setApiKey stays refused even with every lift applied');
check(policyRefusal('post', new Request('GET', '/x'), $everythingLifted) !== null,
    'the raw post transport stays refused even with every lift applied');

// ---------------------------------------------------------------------------
// Block E2 — policy loading, warnings, and fail-closed parsing
// ---------------------------------------------------------------------------
echo "\nBlock E2 — policy loading:\n";

$tmpProject = sys_get_temp_dir() . '/forge-policy-test-' . getmypid();
@mkdir($tmpProject . '/.hermit', 0700, true);
$policyFile = $tmpProject . '/.hermit/forge-policy.json';

putenv('FORGE_POLICY_ALLOW_TIERS=destructive, secrets');
putenv('FORGE_POLICY_ALLOW=deleteServer,deleteSevrer');
file_put_contents($policyFile, json_encode(['deny' => ['monitors', 'notAMethod', 'php*']]));

$policy = loadPolicy($tmpProject);
check($policy['tiers_lifted'] === ['destructive', 'secrets'], 'both tiers lift, whitespace tolerated');
check($policy['methods_lifted'] === ['deleteServer'], 'a typo in FORGE_POLICY_ALLOW is dropped, not honoured');
check(count(array_filter($policy['warnings'], fn($w) => str_contains($w, 'deleteSevrer'))) === 1,
    'the dropped typo produces a warning naming it');
check($policy['project_deny'] === ['monitors', 'php*'], 'a bogus deny entry is dropped, globs are kept');
check(count(array_filter($policy['warnings'], fn($w) => str_contains($w, 'notAMethod'))) === 1,
    'the dropped deny entry produces a warning naming it');

putenv('FORGE_POLICY_ALLOW_TIERS=nonsense');
putenv('FORGE_POLICY_ALLOW=');
$policy = loadPolicy($tmpProject);
check($policy['tiers_lifted'] === [], 'an unrecognized tier name lifts nothing');
check(count($policy['warnings']) >= 1, 'an unrecognized tier name warns');

file_put_contents($policyFile, '{ this is not json');
$policy = loadPolicy($tmpProject);
check($policy['project_deny'] === [], 'malformed forge-policy.json is ignored whole (fail closed)');
check(count(array_filter($policy['warnings'], fn($w) => str_contains($w, 'malformed'))) === 1,
    'malformed forge-policy.json warns');
check($policy['tiers_lifted'] === [] && loadPolicy($tmpProject)['warnings'] !== [],
    'a malformed project file does not disturb the shipped tier defaults');

putenv('FORGE_POLICY_ALLOW_TIERS');
putenv('FORGE_POLICY_ALLOW');
unlink($policyFile);
@rmdir($tmpProject . '/.hermit');
@rmdir($tmpProject);

$policy = loadPolicy($tmpProject);
check($policy === emptyPolicy(), 'with no env and no project file, nothing is lifted and nothing is denied');

// ---------------------------------------------------------------------------
// Block F — verb routing inputs and output scrubbing
//
// `call` accepts a method only when the CAPTURED verb is GET, and routes
// everything else to `preview`. These assert the decision input; Block A already
// proved the captured request is what the SDK would really send.
// ---------------------------------------------------------------------------
echo "\nBlock F — verb routing and scrubbing:\n";

check(captureRequest('deleteMonitor', ['acme', 12, 5])->getMethod() === 'DELETE',
    'a delete captures DELETE (call routes it to preview, policy then denies it)');

check(str_contains(scrubSecrets('DB_PASSWORD=hunter2trombone'), '[REDACTED]')
    && !str_contains(scrubSecrets('DB_PASSWORD=hunter2trombone'), 'hunter2trombone'),
    'a PASSWORD= assignment is redacted');
check(!str_contains(scrubSecrets("-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----"), 'abc'),
    'a PEM block is redacted');
check(scrubSecrets('Authorization: Bearer abcdef1234567890') === 'Authorization: Bearer [REDACTED]',
    'a Bearer blob is redacted');
check(str_contains(scrubSecrets('postgres://app:s3cr3t@db.internal/prod'), '[REDACTED]@'),
    'credentials in a connection URL are redacted');

$ordinaryLog = "Cloning into '/home/forge/app'...\nHEAD is now at 4f2a1b9c8d3e5f6a7b8c9d0e1f2a3b4c5d6e7f80 Fix pagination\nnpm WARN deprecated";
check(scrubSecrets($ordinaryLog) === $ordinaryLog,
    'an ordinary deploy log survives untouched, git SHA included');

// ---------------------------------------------------------------------------
// SDK error output
// ---------------------------------------------------------------------------
echo "\nSDK error output:\n";

$validationBody = [
    'message' => 'The given data was invalid.',
    'errors' => [
        'name' => ['The name has already been taken.', 'The name must be a valid domain.'],
        'type' => ['The selected type is invalid.'],
    ],
];
[$validationForge] = makeMockForge([new Response(422, [], json_encode($validationBody))]);
try {
    $validationForge->createSite('acme', 12, ['type' => 'php', 'name' => 'example.invalid']);
    check(false, '422 raises a validation exception');
} catch (\Laravel\Forge\Exceptions\ValidationException $e) {
    $output = formatSdkError($e);
    check(str_starts_with($output, "SDK error: The given data failed to pass validation.\n"),
        'validation output retains the generic SDK summary');
    $details = json_decode(substr($output, strpos($output, "\n") + 1), true);
    check($details === $validationBody, '422 output retains the envelope, fields and every validation message');
}

$flatErrors = ['name' => ['The name is required.']];
$flatOutput = formatSdkError(new \Laravel\Forge\Exceptions\ValidationException($flatErrors));
check(json_decode(substr($flatOutput, strpos($flatOutput, "\n") + 1), true) === $flatErrors,
    'flat validation details retain their structure');
check(formatSdkError(new \Laravel\Forge\Exceptions\ValidationException([]))
    === "SDK error: The given data failed to pass validation.\n",
    'empty validation details retain the summary without an empty appendix');
check(formatSdkError(new \RuntimeException('Connection failed.')) === "SDK error: Connection failed.\n",
    'ordinary exceptions retain their message and trailing newline');
$secretOutput = formatSdkError(new \Laravel\Forge\Exceptions\ValidationException([
    'errors' => ['name' => ['Invalid DB_PASSWORD=hunter2trombone', 'Invalid https://app:s3cr3t@example.invalid/path']],
]));
check(!str_contains($secretOutput, 'hunter2trombone') && !str_contains($secretOutput, 's3cr3t')
    && str_contains($secretOutput, '[REDACTED]'), 'validation details scrub assignments and URL credentials');
check(!str_contains(formatSdkError(new \RuntimeException('Authorization: Bearer abcdef1234567890')), 'abcdef1234567890'),
    'ordinary exception messages are scrubbed too');

// ---------------------------------------------------------------------------
// Block G — SDK surface tripwire
//
// These three counts are the ONLY inputs the reachability policy derives from.
// A vendor bump that changes any of them fails here on purpose: the next person
// must look at what the SDK added and decide whether the deny tiers still cover
// it, THEN update the number. Do not update the number first.
// ---------------------------------------------------------------------------
echo "\nBlock G — SDK surface tripwire:\n";

$publics = (new \ReflectionClass(Forge::class))->getMethods(\ReflectionMethod::IS_PUBLIC);
$names   = array_map(fn($m) => $m->getName(), $publics);
$endpoints = array_values(array_filter($names, 'isEndpointMethod'));
$plumbing  = array_values(array_diff($names, $endpoints));
$orgLess   = array_values(array_filter($endpoints, fn($n) => !takesOrgFirst($n)));

check(count($endpoints) === 271, 'SDK exposes 271 endpoint methods (got ' . count($endpoints) . ')');
check(count($plumbing) === 11, 'SDK exposes 11 non-endpoint publics (got ' . count($plumbing) . ')');
check(count($orgLess) === 19, '19 endpoint methods take no org slug (got ' . count($orgLess) . ')');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
echo "\nResults: $passed passed, $failed failed\n";
exit($failed > 0 ? 1 : 0);
