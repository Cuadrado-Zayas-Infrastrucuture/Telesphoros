<?php
// Regression probe for the real OpenEMR caller; synthetic identifiers, no database.
// Suppress code-types bootstrap DB reads; the lookup seam below captures arguments.
define('OPENEMR_STATIC_ANALYSIS', true);
require '/var/www/localhost/htdocs/openemr/vendor/autoload.php';
use OpenEMR\Common\Http\HttpRestRequest;
use OpenEMR\RestControllers\Authorization\BearerTokenAuthorizationStrategy;
use Psr\Log\NullLogger;
class SyntheticContextProbe extends BearerTokenAuthorizationStrategy {
    public $seenUser;
    public bool $allow = true;
    public function __construct() { $this->setLogger(new NullLogger()); }
    public function getTokenContextForRequest(HttpRestRequest $request) {
        return ['patient' => '11111111-1111-4111-8111-111111111111'];
    }
    protected function checkUserHasAccessToPatient($userId, $patientUuid): bool {
        $this->seenUser = $userId;
        return $this->allow;
    }
}
$uuid = '22222222-2222-4222-8222-222222222222';
$probe = new SyntheticContextProbe();
$request = new HttpRestRequest();
$request->setRequestUser($uuid, ['id' => 123]);
$probe->populateTokenContextForRequest($request);
if ($probe->seenUser !== $uuid) { fwrite(STDERR, "FAIL: patient-access check received numeric user ID instead of UUID\n"); exit(1); }
if ($request->getPatientUUIDString() !== '11111111-1111-4111-8111-111111111111') { throw new RuntimeException('Allowed patient not bound'); }
$probe->allow = false;
$denied = new HttpRestRequest();
$denied->setRequestUser($uuid, ['id' => 123]);
$probe->populateTokenContextForRequest($denied);
if ($denied->getPatientUUIDString() !== null) { throw new RuntimeException('Denied patient was bound'); }
echo "PASS: UUID forwarded; denied patient remains unbound\n";

// The patient service stores binary UUIDs; test the real lookup boundary too.
class SyntheticPatientServiceProbe extends \OpenEMR\Services\PatientService {
    public $seenUuid;
    public function __construct() {}
    public function getPidByUuid($uuid) { $this->seenUuid = $uuid; return 123; }
    public function findByPid($pid) { return ['pid' => $pid]; }
}
class SyntheticLookupProbe extends SyntheticContextProbe {
    public function lookup($uuid) { return parent::findPatientByUuid($uuid); }
}
$patientService = new SyntheticPatientServiceProbe();
$lookup = new SyntheticLookupProbe();
$lookup->setPatientService($patientService);
$lookup->lookup('11111111-1111-4111-8111-111111111111');
if ($patientService->seenUuid !== hex2bin('11111111111141118111111111111111')) {
    fwrite(STDERR, "FAIL: patient service received textual UUID instead of binary UUID\n"); exit(1);
}
echo "PASS: patient UUID converted at the database boundary\n";
