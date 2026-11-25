# Spanish for the shell and the sign-in pages (spec 050 LS2)

For the founders to fill in. Each row is one fixed string of a word table, with its key and its English exactly as the app shows it.
`{1}` and `{2}` are placeholders: the app puts a value there (a number, a role, a width), and the Spanish must keep each one. Write the Spanish
in the last column. It is not machine translated (spec 050 R8). These are interface strings, so one founder checks them (LS2-D4). Then LS2b
puts them in the tables, with the reviewer's name and the date.

`apps/frontend/src/lib/words/ls2List.test.ts` keeps this list in step with the tables: a string added, removed or changed in the code without
its row here fails the test.

## The `shell` screen

### `shell-sidebar`

| Key | English | Spanish |
| --- | --- | --- |
| `shell-sidebar.logoAlt` | Telesphoros shield and Rx logo |  |
| `shell-sidebar.expand` | Expand sidebar |  |
| `shell-sidebar.collapse` | Collapse sidebar |  |
| `shell-sidebar.menu` | Workspace navigation |  |
| `shell-sidebar.primary` | Primary |  |
| `shell-sidebar.home` | Home |  |
| `shell-sidebar.chat` | Chat |  |
| `shell-sidebar.workspace` | Workspace |  |
| `shell-sidebar.chatPreview` | Chat preview |  |
| `shell-sidebar.patients` | Patients |  |
| `shell-sidebar.reports` | Reports |  |
| `shell-sidebar.followups` | Follow-ups |  |
| `shell-sidebar.followupsCount` | Follow-ups ({1}) |  |
| `shell-sidebar.usage` | Usage |  |
| `shell-sidebar.recents` | Recents |  |
| `shell-sidebar.recentReports` | Recent reports |  |
| `shell-sidebar.reportsFailed` | Reports could not be loaded. |  |
| `shell-sidebar.retry` | Retry |  |
| `shell-sidebar.loadingReports` | Loading reports… |  |
| `shell-sidebar.noReports` | No reports yet. |  |
| `shell-sidebar.account` | Account, {1} |  |
| `shell-sidebar.roleSynthetic` | {1} · Synthetic |  |
| `shell-sidebar.syntheticEnvironment` | Synthetic environment |  |
| `shell-sidebar.roleAdmin` | admin |  |
| `shell-sidebar.roleReviewer` | reviewer |  |
| `shell-sidebar.roleClinician` | clinician |  |
| `shell-sidebar.roleReader` | reader |  |
| `shell-sidebar.roleNone` | user with no role |  |
| `shell-sidebar.width` | Sidebar width |  |
| `shell-sidebar.widthValue` | {1} rem wide |  |
| `shell-sidebar.resizeHint` | Drag to resize. Double-click to reset. |  |

### `shell-account-menu`

| Key | English | Spanish |
| --- | --- | --- |
| `shell-account-menu.settings` | Settings |  |
| `shell-account-menu.language` | Language |  |
| `shell-account-menu.english` | English |  |
| `shell-account-menu.currentLanguage` | Current language |  |
| `shell-account-menu.help` | Help |  |
| `shell-account-menu.getHelp` | Get help |  |
| `shell-account-menu.sendFeedback` | Send feedback |  |
| `shell-account-menu.reportBug` | Report a bug |  |
| `shell-account-menu.theme` | Theme |  |
| `shell-account-menu.themeAuto` | Auto |  |
| `shell-account-menu.themeAutoName` | Auto (match this device) |  |
| `shell-account-menu.themeLight` | Light |  |
| `shell-account-menu.themeDark` | Dark |  |
| `shell-account-menu.learnMore` | Learn more |  |
| `shell-account-menu.changelog` | View changelog |  |
| `shell-account-menu.securityPolicy` | Security policy |  |
| `shell-account-menu.codeOfConduct` | Code of conduct |  |
| `shell-account-menu.license` | License |  |
| `shell-account-menu.signOut` | Sign out |  |

### `shell-frame`

| Key | English | Spanish |
| --- | --- | --- |
| `shell-frame.loadingPage` | Loading page… |  |

## The `sign-in` screen

### `sign-in`

| Key | English | Spanish |
| --- | --- | --- |
| `sign-in.title` | Sign in |  |
| `sign-in.heading` | Sign in |  |
| `sign-in.intro` | You will be taken to the secure sign-in page. Accounts are by invitation only: if you need access, ask your administrator. |  |
| `sign-in.unreachable` | Could not reach the sign-in page |  |
| `sign-in.checkConnection` | Check your connection and try again. |  |
| `sign-in.button` | Sign in |  |
| `sign-in.redirecting` | Redirecting… |  |

### `signed-out`

| Key | English | Spanish |
| --- | --- | --- |
| `signed-out.title` | Signed out |  |
| `signed-out.heading` | You have been signed out |  |
| `signed-out.body` | Close this window, or sign in again to continue. |  |
| `signed-out.signIn` | Sign in |  |

### `sign-in-callback`

| Key | English | Spanish |
| --- | --- | --- |
| `sign-in-callback.title` | Signing you in |  |
| `sign-in-callback.heading` | Signing you in |  |
| `sign-in-callback.wait` | Please wait… |  |
| `sign-in-callback.accountHeading` | Your account is not set up yet |  |
| `sign-in-callback.accountTitle` | No organization is assigned to your account |  |
| `sign-in-callback.accountBody` | You signed in successfully, but your account does not belong to an organization yet. Ask your administrator to add you to one. Trying again will not help until they do. |  |
| `sign-in-callback.failedHeading` | Sign-in did not complete |  |
| `sign-in-callback.failedTitle` | We could not sign you in |  |
| `sign-in-callback.failedBody` | The sign-in link may have expired or been used already. Please try again. |  |
| `sign-in-callback.tryAgain` | Try again |  |

## Already in Spanish: to review and sign (LS2-D2, LS2-D3)

These strings already have Spanish, written for the landing page and recorded as a draft not yet reviewed by a Spanish speaker
(`lib/landing/landing-copy.ts`, `components/privacy/StorageConsentProvider.tsx`). The signed-in shell will show the same text, so the landing and
the shell never say different things. Correct the Spanish where needed, then sign it.
They are the header's and footer's strings and the consent bar's, which the landing and the shell share.

| Key | English | Spanish (draft) | Reviewed Spanish |
| --- | --- | --- | --- |
| `landing.header.nav` | Primary | Principal |  |
| `landing.header.features` | Features | Funciones |  |
| `landing.header.faq` | FAQ | Preguntas |  |
| `landing.header.byline` | by Cuadrado Zayas Infrastructure | de Cuadrado Zayas Infrastructure |  |
| `landing.header.logoAlt` | Telesphoros shield and Rx logo | Logotipo de Telesphoros: escudo y Rx |  |
| `landing.header.signIn` | Sign in | Iniciar sesión |  |
| `landing.header.openWorkspace` | Open workspace | Abrir el espacio de trabajo |  |
| `landing.header.skip` | Skip to main content | Saltar al contenido principal |  |
| `landing.footer.companyAlt` | Cuadrado Zayas Infrastructure company symbol | Símbolo de la empresa Cuadrado Zayas Infrastructure |  |
| `landing.footer.lead` | Report software in development. Use  | Software de informes en desarrollo. Usa  |  |
| `landing.footer.strong` | synthetic data only | solo datos sintéticos |  |
| `landing.footer.tail` | . Not for clinical use. | . No apto para uso clínico. |  |
| `consent.title` | Cookies and browser storage | Cookies y almacenamiento del navegador |  |
| `consent.message` | Optional storage remembers display and language settings. Sign-in and upload recovery use required session storage. | El almacenamiento opcional recuerda la apariencia y el idioma. El inicio de sesión y la recuperación de cargas usan almacenamiento de sesión requerido. |  |
| `consent.necessary` | Use necessary only | Solo lo necesario |  |
| `consent.allow` | Allow preferences | Permitir preferencias |  |
| `consent.manage` | Manage | Configurar |  |
| `consent.reopen` | Cookie settings | Opciones de cookies |  |
| `consent.close` | Close cookie settings | Cerrar opciones de cookies |  |
| `consent.requiredTitle` | Required app storage | Almacenamiento requerido |  |
| `consent.required` | Sign-in state and unfinished-upload recovery stay available. Your sign-in provider manages its own session. | El inicio de sesión y la recuperación de cargas permanecen disponibles. El proveedor de acceso administra su propia sesión. |  |
| `consent.always` | Always on | Siempre activo |  |
| `consent.optional` | Remember display and language settings | Recordar apariencia e idioma |  |
| `consent.optionalHelp` | Optional: save your theme, sidebar layout and landing-page language on this device. Without this, choices still work for this tab. | Opcional: guardar el tema, el panel lateral y el idioma de la página principal en este dispositivo. Sin esto, las opciones siguen funcionando en esta pestaña. |  |
| `consent.scope` | These controls cover saved browser preferences. They do not change application record events. | Estos controles cubren las preferencias del navegador. No cambian los eventos de registros de la aplicación. |  |
| `consent.save` | Save choices | Guardar opciones |  |
| `consent.temporary` | This browser could not save the decision. It applies to this tab only. | El navegador no pudo guardar la decisión. Solo se aplica a esta pestaña. |  |
| `consent.clearProblem` | Your choice applies now, but this browser prevented clearing saved preferences. Use its site-data controls to remove them. | La decisión se aplica ahora, pero el navegador impidió borrar preferencias guardadas. Usa sus controles de datos del sitio para eliminarlas. |  |
