<?php
// SPDX-License-Identifier: GPL-3.0-or-later
// Local synthetic pilot extension; no prescribing or chart writeback.
use OpenEMR\Core\OEGlobalsBag;
use OpenEMR\Common\Session\SessionWrapperFactory;
use OpenEMR\Common\Csrf\CsrfUtils;
use OpenEMR\Events\PatientDemographics\RenderEvent;

if (getenv('TELESPHOROS_SYNTHETIC_PILOT') !== '1') {
    return;
}
OEGlobalsBag::getInstance()->getKernel()->getEventDispatcher()->addListener(
    RenderEvent::EVENT_SECTION_LIST_RENDER_AFTER,
    function (RenderEvent $event): void {
        $patient = sqlQuery('SELECT pubpid FROM patient_data WHERE pid = ?', [$event->getPid()]);
        if (!str_starts_with($patient['pubpid'] ?? '', 'TSP-SYNTHETIC-')) {
            return;
        }
        $url = OEGlobalsBag::getInstance()->getKernel()->getWebRoot()
            . '/interface/modules/custom_modules/oe-module-telesphoros-pilot/launch.php?'
            . http_build_query(['pid' => $event->getPid(), 'csrf_token' => CsrfUtils::collectCsrfToken(SessionWrapperFactory::getInstance()->getActiveSession())]);
        echo '<section class="card p-3"><h2>Telesphoros synthetic pilot</h2>';
        echo '<p>Read-only PGx context review. No clinical recommendations.</p>';
        echo '<a target="_blank" rel="noopener noreferrer" href="' . attr($url) . '">Open synthetic PGx review in a new tab</a></section>';
    }
);
