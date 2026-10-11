<?php
// CLI-only provisioning for the dedicated synthetic Docker project. Never a web route.
if (PHP_SAPI !== 'cli' || getenv('TELESPHOROS_SYNTHETIC_PILOT') !== '1') {
    throw new RuntimeException('Synthetic CLI environment required');
}
mysqli_report(MYSQLI_REPORT_ERROR | MYSQLI_REPORT_STRICT);
$db = new mysqli(getenv('MYSQL_HOST'), 'root', getenv('MYSQL_ROOT_PASS'), 'openemr');
function query($sql, $params = []) {
    global $db;
    $statement = $db->prepare($sql);
    $statement->execute($params);
    return $statement;
}
if ((int) query('SELECT COUNT(*) n FROM patient_data WHERE pubpid IS NULL OR pubpid NOT IN (?, ?)', ['TSP-SYNTHETIC-1', 'TSP-SYNTHETIC-2'])->get_result()->fetch_assoc()['n'] !== 0) {
    throw new RuntimeException('Refusing to seed a database containing non-pilot patients');
}
$config = json_decode(file_get_contents('/tmp/smart-pilot-seed.json'), true, 512, JSON_THROW_ON_ERROR);
$db->begin_transaction();
foreach ([['rest_fhir_api', '1'], ['site_addr_oath', 'http://127.0.0.1:8301']] as [$name, $value]) {
    query('INSERT INTO globals (gl_name, gl_index, gl_value) VALUES (?, 0, ?) ON DUPLICATE KEY UPDATE gl_value = VALUES(gl_value)', [$name, $value]);
}
query('UPDATE users SET uuid = COALESCE(uuid, ?), authorized = 1, npi = ? WHERE username = ?', [hex2bin(str_replace('-', '', $config['clinicianUuid'])), '0000000000', 'synthetic-admin']);
foreach ($config['patients'] as $index => $patient) {
    $pid = 910001 + $index;
    $pubpid = 'TSP-SYNTHETIC-' . ($index + 1);
    $existing = query('SELECT pid, HEX(uuid) AS uuid_hex FROM patient_data WHERE pubpid = ?', [$pubpid])->get_result()->fetch_assoc();
    if ($existing && ((int) $existing['pid'] !== $pid || strtolower($existing['uuid_hex']) !== str_replace('-', '', $patient['fhirId']))) {
        throw new RuntimeException('Synthetic fixture identity drift; refusing to overwrite or remap');
    }
    if (!$existing) {
        query('INSERT INTO patient_data (uuid,pid,pubpid,fname,lname,DOB,sex,date) VALUES (?,?,?,?,?,?,?,NOW())',
            [hex2bin(str_replace('-', '', $patient['fhirId'])), $pid, $pubpid, 'Synthetic', 'Pilot ' . ($index + 1), '1990-01-01', 'Female']);
        query('INSERT INTO prescriptions (uuid,patient_id,provider_id,drug,rxnorm_drugcode,active,date_added,date_modified,start_date,txDate,usage_category_title,request_intent,request_intent_title) VALUES (?,?,?,?,?,1,NOW(),NOW(),CURRENT_DATE(),CURRENT_DATE(),?,?,?)',
            [hex2bin(str_replace('-', '', $patient['medicationUuid'])), $pid, 1, 'Synthetic fixture medication', '32968', 'Home/Community', 'order', 'Order']);
    }
}
$clientId = 'synthetic-telesphoros';
if (!query('SELECT client_id FROM oauth_clients WHERE client_id = ?', [$clientId])->get_result()->fetch_assoc()) {
    query('INSERT INTO oauth_clients (client_id,client_role,client_name,redirect_uri,grant_types,scope,site_id,is_confidential,is_enabled,initiate_login_uri,skip_ehr_launch_authorization_flow,dsi_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [$clientId, 'user', 'Telesphoros synthetic read-only pilot', 'http://127.0.0.1:8767/auth/fhir/pilot/callback', 'authorization_code',
         'launch openid fhirUser patient/Patient.r patient/MedicationRequest.rs', 'default', 0, 1, 'http://127.0.0.1:8767/auth/fhir/pilot/launch/openemr', 0, 0]);
}
$module = 'oe-module-telesphoros-pilot';
if (!query('SELECT mod_id FROM modules WHERE mod_directory = ?', [$module])->get_result()->fetch_assoc()) {
    query('INSERT INTO modules (mod_name,mod_directory,mod_active,mod_ui_name,directory,date,type,sql_version,acl_version) VALUES (?,?,?,?,?,NOW(),?,?,?)',
        ['TelesphorosSyntheticPilot', $module, 1, 'Telesphoros synthetic pilot', $module, 0, '0', '0']);
}
$db->commit();
echo "Synthetic patients and read-only SMART registration provisioned.\n";
