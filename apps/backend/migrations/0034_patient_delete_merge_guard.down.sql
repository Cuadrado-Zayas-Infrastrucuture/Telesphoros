-- Removes the two guards. Changes no data: merges and deletes made while they existed stay as they are.
DROP TRIGGER patients_guard_delete ON patients;
DROP FUNCTION patients_guard_delete();
DROP TRIGGER patient_merge_decisions_a_hold ON patient_merge_decisions;
DROP FUNCTION patient_merge_decisions_hold();
