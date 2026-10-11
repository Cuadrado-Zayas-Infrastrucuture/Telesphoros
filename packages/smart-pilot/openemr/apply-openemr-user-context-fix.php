<?php
// Build-time compatibility patch only, pinned to the reviewed OpenEMR source.
$file = '/var/www/localhost/htdocs/openemr/src/RestControllers/Authorization/BearerTokenAuthorizationStrategy.php';
if (hash_file('sha256', $file) !== '5180514730733f0a7ad0b960ba08e5608b7938afc666c54d8c7439db5cea2d94') {
    throw new RuntimeException('OpenEMR source drift: re-review the patient-context fix');
}
$before = '$this->checkUserHasAccessToPatient($restRequest->getRequestUserId(), $patientUuid)';
$after = '$this->checkUserHasAccessToPatient($restRequest->getRequestUserUUIDString(), $patientUuid)';
$content = file_get_contents($file);
if (substr_count($content, $before) !== 1) { throw new RuntimeException('Unexpected OpenEMR call site'); }

$content = str_replace($before, $after, $content);
$patientBefore = '$patientService->getPidByUuid($patientUuid)';
$patientAfter = '$patientService->getPidByUuid(UuidRegistry::uuidToBytes($patientUuid))';
if (substr_count($content, $patientBefore) !== 1) { throw new RuntimeException('Unexpected patient lookup'); }
file_put_contents($file, str_replace($patientBefore, $patientAfter, $content));
echo "Applied user and patient UUID boundary corrections; authorization implementation unchanged\n";
