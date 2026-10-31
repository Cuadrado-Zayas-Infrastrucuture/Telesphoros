/*
 * All text of the product landing, in the two supported languages (plan: docs/design/plans/landing-alignment.md, S3).
 *
 * - `en` is the source of truth. It was refreshed on 2026-10-31 to match the prototype as it is: the chat home (specs/024),
 *   adding a patient from the panel, JSON-only intake on staging, and the public site's PGx-interpretation framing.
 * - `es` is a DRAFT translation that has not been reviewed by a Spanish-speaking reviewer. It must not ship before that
 *   review (see docs/STATUS.md). Every boundary statement (synthetic data only, not for clinical use, no medication or
 *   dose recommendation, verification is storage and not clinical review) must keep exactly the same meaning in both.
 * - Only text lives here: no markup, no colours, no behaviour. `landing-copy.test.ts` keeps the two languages in step.
 */
const en = {
  header: {
    nav: 'Primary',
    features: 'Features',
    faq: 'FAQ',
    byline: 'by Cuadrado Zayas Infrastructure',
    logoAlt: 'Telesphoros shield and Rx logo',
    signIn: 'Sign in',
    openWorkspace: 'Open workspace',
    skip: 'Skip to main content',
  },
  footer: {
    companyAlt: 'Cuadrado Zayas Infrastructure company symbol',
    lead: 'Report software in development. Use ',
    strong: 'synthetic data only',
    tail: '. Not for clinical use.',
  },
  language: { switchTo: 'Español', switchLang: 'es', group: 'Language' },
  actions: {
    upload: 'Upload a synthetic report',
    signIn: 'Sign in to Telesphoros',
    open: 'Open workspace',
    how: 'See how it works ',
  },
  hero: {
    eyebrow: 'Pharmacogenomic report software',
    headline: ['PGx reports,', 'interpreted with care.'],
    copy: 'Telesphoros is being built to help clinicians interpret pharmacogenomic reports, with every statement traced to the report. Today’s prototype takes in synthetic reports and tracks their status.',
    note: ['Prototype. Synthetic data only.', ' Not for clinical use.'],
    product: 'A product of Cuadrado Zayas Infrastructure',
    index: 'See what the prototype does ',
  },
  card: {
    patient: 'Example patient',
    label: 'Synthetic example',
    foot: 'Synthetic data only. Not for clinical use.',
  },
  statuses: { verified: 'Server verified', incomplete: 'Not complete', received: 'Received' },
  purpose: {
    eyebrow: 'Why we’re building Telesphoros',
    title: 'Working toward less trial-and-error prescribing.',
    p1: 'People respond differently to medicines. Pharmacogenomics examines how genetic differences influence that response, alongside other factors that matter in care.',
    p2: 'Our goal is to help clinicians and pharmacists bring pharmacogenomic information into prescribing decisions.',
    todayTitle: 'Where we are today',
    today:
      'The prototype starts with patient-linked reports, verified file storage and a chat home that shows each report’s status. Clinical interpretation and prescribing recommendations are not available yet.',
    source: 'About pharmacogenomics · NHGRI',
  },
  capabilities: {
    eyebrow: 'Available in this prototype',
    title: ['Built around', 'the report.'],
    intro: 'A chat home with every feature in a side panel, patient-linked intake and a status for every file.',
    rows: [
      {
        title: 'Keep the patient and report connected.',
        text: 'Choose a synthetic patient, or add one by label from the side panel, then attach a structured JSON report. Raw genomic files are not accepted.',
        note: 'Uploads require a clinician role.',
      },
      {
        title: 'Find a file. Check its status.',
        text: 'Past reports sit in the side panel with their status. All reports lists every report you can see, with its format and upload status.',
        note: 'File verification confirms storage, not clinical review.',
      },
      {
        title: 'Start from the chat.',
        text: 'After you sign in, the chat is your home. Attach a report and send it to see its status in the conversation. A typed question gets a note, not an answer.',
        note: 'No live AI or prescribing recommendations.',
      },
    ],
  },
  fragments: {
    patient: 'Example patient',
    question: 'What does this report show?',
    answer: 'Interpretation is not available in the prototype yet.',
  },
  questions: {
    eyebrow: 'Before you begin',
    title: ['Access and', 'prototype questions.'],
    items: [
      {
        q: 'Who can access Telesphoros?',
        a: 'Access is by invitation. Ask your organization’s administrator for an account. Signing in does not change your existing permissions.',
      },
      {
        q: 'Can I upload real patient reports?',
        a: 'No. Use synthetic records only. This environment is not approved for clinical use, and real patient information must not be entered or uploaded.',
      },
      {
        q: 'What does “verified” mean?',
        a: 'It means the server verified the stored file. It does not indicate clinical review: the report has not been clinically interpreted, and no treatment recommendation has been established.',
      },
      {
        q: 'Does Telesphoros recommend a medication?',
        a: 'No. Less trial-and-error prescribing is our direction, not an outcome established by this prototype. It does not recommend medications or doses, and is not for clinical use.',
      },
      {
        q: 'Does the chat interpret my reports?',
        a: 'No. In this prototype the chat uploads a report and shows its status. A typed question gets the note “Interpretation is not available in the prototype yet.”',
      },
    ],
  },
  closing: {
    eyebrow: 'Telesphoros',
    title: 'Take a look inside Telesphoros.',
    text: 'Sign in with your existing account to try the prototype using synthetic records.',
    note: 'Access is by invitation.',
    mascotAlt: 'Telesphoros mascot in a teal cloak',
  },
};

export type LandingCopy = typeof en;
export type LandingLanguage = 'en' | 'es';

// DRAFT: not yet reviewed by a Spanish-speaking reviewer. See the note at the top of this file.
const es: LandingCopy = {
  header: {
    nav: 'Principal',
    features: 'Funciones',
    faq: 'Preguntas',
    byline: 'de Cuadrado Zayas Infrastructure',
    logoAlt: 'Logotipo de Telesphoros: escudo y Rx',
    signIn: 'Iniciar sesión',
    openWorkspace: 'Abrir el espacio de trabajo',
    skip: 'Saltar al contenido principal',
  },
  footer: {
    companyAlt: 'Símbolo de la empresa Cuadrado Zayas Infrastructure',
    lead: 'Software de informes en desarrollo. Usa ',
    strong: 'solo datos sintéticos',
    tail: '. No apto para uso clínico.',
  },
  language: { switchTo: 'English', switchLang: 'en', group: 'Idioma' },
  actions: {
    upload: 'Cargar un informe sintético',
    signIn: 'Iniciar sesión en Telesphoros',
    open: 'Abrir el espacio de trabajo',
    how: 'Ver cómo funciona ',
  },
  hero: {
    eyebrow: 'Software de informes farmacogenómicos',
    headline: ['Informes PGx,', 'interpretados con cuidado.'],
    copy: 'Telesphoros se está construyendo para ayudar a los clínicos a interpretar informes farmacogenómicos, con cada afirmación vinculada al informe. El prototipo actual recibe informes sintéticos y muestra su estado.',
    note: ['Prototipo. Solo datos sintéticos.', ' No apto para uso clínico.'],
    product: 'Un producto de Cuadrado Zayas Infrastructure',
    index: 'Mira lo que hace el prototipo ',
  },
  card: {
    patient: 'Paciente de ejemplo',
    label: 'Ejemplo sintético',
    foot: 'Solo datos sintéticos. No apto para uso clínico.',
  },
  statuses: { verified: 'Verificado por el servidor', incomplete: 'Incompleto', received: 'Recibido' },
  purpose: {
    eyebrow: 'Por qué estamos creando Telesphoros',
    title: 'Trabajamos para reducir la prescripción por ensayo y error.',
    p1: 'Las personas responden de manera distinta a los medicamentos. La farmacogenómica estudia cómo las diferencias genéticas influyen en esa respuesta, junto con otros factores que importan en la atención.',
    p2: 'Nuestro objetivo es ayudar a clínicos y farmacéuticos a incorporar la información farmacogenómica en las decisiones de prescripción.',
    todayTitle: 'Dónde estamos hoy',
    today:
      'El prototipo comienza con informes vinculados a pacientes, almacenamiento de archivos verificado y un inicio de chat que muestra el estado de cada informe. La interpretación clínica y las recomendaciones de prescripción aún no están disponibles.',
    source: 'Acerca de la farmacogenómica · NHGRI',
  },
  capabilities: {
    eyebrow: 'Disponible en este prototipo',
    title: ['Construido en torno', 'al informe.'],
    intro: 'Un inicio de chat con todas las funciones en un panel lateral, carga vinculada a pacientes y un estado para cada archivo.',
    rows: [
      {
        title: 'Mantén unidos al paciente y al informe.',
        text: 'Elige un paciente sintético, o agrega uno por etiqueta desde el panel lateral, y luego adjunta un informe JSON estructurado. No se aceptan archivos genómicos sin procesar.',
        note: 'Cargar requiere un rol de clínico.',
      },
      {
        title: 'Encuentra un archivo. Revisa su estado.',
        text: 'Los informes anteriores aparecen en el panel lateral con su estado. Todos los informes muestra cada informe que puedes ver, con su formato y el estado de carga.',
        note: 'La verificación del archivo confirma el almacenamiento, no una revisión clínica.',
      },
      {
        title: 'Empieza desde el chat.',
        text: 'Al iniciar sesión, el chat es tu inicio. Adjunta un informe y envíalo para ver su estado en la conversación. Una pregunta escrita recibe una nota, no una respuesta.',
        note: 'Sin IA en vivo ni recomendaciones de prescripción.',
      },
    ],
  },
  fragments: {
    patient: 'Paciente de ejemplo',
    question: '¿Qué muestra este informe?',
    answer: 'La interpretación aún no está disponible en el prototipo.',
  },
  questions: {
    eyebrow: 'Antes de empezar',
    title: ['Preguntas sobre', 'acceso y el prototipo.'],
    items: [
      {
        q: '¿Quién puede acceder a Telesphoros?',
        a: 'El acceso es por invitación. Pide una cuenta al administrador de tu organización. Iniciar sesión no cambia tus permisos existentes.',
      },
      {
        q: '¿Puedo cargar informes reales de pacientes?',
        a: 'No. Usa solo registros sintéticos. Este entorno no está aprobado para uso clínico y no se debe ingresar ni cargar información real de pacientes.',
      },
      {
        q: '¿Qué significa «verificado»?',
        a: 'Significa que el servidor verificó el archivo almacenado. No indica revisión clínica: el informe no ha sido interpretado clínicamente y no se ha establecido una recomendación de tratamiento.',
      },
      {
        q: '¿Telesphoros recomienda un medicamento?',
        a: 'No. Reducir la prescripción por ensayo y error es nuestra dirección, no un resultado establecido por este prototipo. No recomienda medicamentos ni dosis, y no es para uso clínico.',
      },
      {
        q: '¿El chat interpreta mis informes?',
        a: 'No. En este prototipo el chat carga un informe y muestra su estado. Una pregunta escrita recibe la nota «La interpretación aún no está disponible en el prototipo».',
      },
    ],
  },
  closing: {
    eyebrow: 'Telesphoros',
    title: 'Echa un vistazo a Telesphoros.',
    text: 'Inicia sesión con tu cuenta existente para probar el prototipo con registros sintéticos.',
    note: 'El acceso es por invitación.',
    mascotAlt: 'Mascota de Telesphoros con una capa verde azulada',
  },
};

export const LANDING_COPY: Record<LandingLanguage, LandingCopy> = { en, es };
