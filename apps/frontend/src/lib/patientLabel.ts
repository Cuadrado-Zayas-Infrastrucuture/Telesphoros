import { createContext, useContext } from 'react';

/**
 * The label of the patient whose record is open, for the points where an entry about them is confirmed (specs/038 D2, D7). It is the
 * synthetic label the page title already carries, never a name. Null outside a patient's page.
 */
export const PatientLabelContext = createContext<string | null>(null);

export const usePatientLabel = () => useContext(PatientLabelContext);
