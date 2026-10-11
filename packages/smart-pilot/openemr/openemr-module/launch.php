<?php
// SPDX-License-Identifier: GPL-3.0-or-later
require_once __DIR__ . '/../../../globals.php';

use OpenEMR\Common\Session\SessionWrapperFactory;
use OpenEMR\FHIR\SMART\SmartLaunchController;
use OpenEMR\FHIR\SMART\SMARTLaunchToken;

$session = SessionWrapperFactory::getInstance()->getActiveSession();
if (getenv('TELESPHOROS_SYNTHETIC_PILOT') !== '1' ||
    !ctype_digit((string) ($_GET['pid'] ?? '')) ||
    (string) $session->get('pid') !== (string) $_GET['pid']) {
    http_response_code(409);
    exit('Patient context changed. Return to the chart and launch again.');
}
$patient = sqlQuery('SELECT pubpid FROM patient_data WHERE pid = ?', [$session->get('pid')]);
if (!str_starts_with($patient['pubpid'] ?? '', 'TSP-SYNTHETIC-')) {
    http_response_code(403);
    exit('Synthetic patient required.');
}
try {
    (new SmartLaunchController())->redirectAndLaunchSmartApp(
        SMARTLaunchToken::INTENT_PATIENT_DEMOGRAPHICS_DIALOG, 'synthetic-telesphoros', $_GET['csrf_token'] ?? null, []
    );
} catch (Throwable $error) {
    http_response_code(400);
    echo 'SMART launch rejected. Return to the chart and launch again.';
}
