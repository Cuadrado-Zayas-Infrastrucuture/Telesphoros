# Synthetic patient setup and upload handoff

The upload page selects an existing patient; it does not create one. When the roster is empty, it asks a **clinician** to add a synthetic patient, then directs the user to the existing **Refresh patients** button. Do not resolve an empty roster by assigning clinical permissions to an administrator.

The current setup path is the authenticated `POST /api/v1/patients` API with the strict input `{ "label": "SYN-0001" }`. The caller must hold the clinician role in the target organization; the server takes organization and identity from the verified caller, not from the request body. Use only synthetic labels under the existing validation policy. The response supplies the patient ID used by subsequent upload selection. An API/setup operator may assist a clinician with the supported request without using database-owner inserts or replacing authorization with privileged credentials.

An `admin` alone manages membership and invitations, but cannot create or read clinical patients. A person who needs clinical work holds the separately assigned clinician role. Reader/reviewer status does not grant patient creation. See [roles and membership](../auth.md).

After authorized setup, refresh the upload roster and choose the correct existing patient. Patient-create/search screens and a full onboarding workflow remain separate product work. This guidance changes no API, role, tenant boundary, upload behavior or synthetic-only requirement.
