import { defineWords } from './defineWords';

/*
 * The shell's fixed words (spec 050 LS2a): the sidebar with Recents, the account menu and the frame. English only until the founders' Spanish
 * (LS2b), which goes into each table's `es`. Interface strings, not clinical (LS2-D4). Patient labels and report names are data and never appear
 * here. The account menu's "Español: aún no disponible" stays in the component: it is already Spanish, marked lang="es", and is replaced by the
 * real choice in LS6 (LS2-D5). The header, footer and skip link come from the landing's copy (`lib/landing/landing-copy.ts`, LS2-D2).
 */

export const SIDEBAR_WORDS = defineWords({
  id: 'shell-sidebar',
  en: {
    logoAlt: 'Telesphoros shield and Rx logo',
    expand: 'Expand sidebar',
    collapse: 'Collapse sidebar',
    menu: 'Workspace navigation',
    primary: 'Primary',
    home: 'Home',
    chat: 'Chat',
    workspace: 'Workspace',
    chatPreview: 'Chat preview',
    patients: 'Patients',
    reports: 'Reports',
    followups: 'Follow-ups',
    followupsCount: (count: string) => `Follow-ups (${count})`,
    usage: 'Usage',
    recents: 'Recents',
    recentReports: 'Recent reports',
    reportsFailed: 'Reports could not be loaded.',
    retry: 'Retry',
    loadingReports: 'Loading reports…',
    noReports: 'No reports yet.',
    account: (role: string) => `Account, ${role}`,
    roleSynthetic: (role: string) => `${role} · Synthetic`,
    syntheticEnvironment: 'Synthetic environment',
    roleAdmin: 'admin',
    roleReviewer: 'reviewer',
    roleClinician: 'clinician',
    roleReader: 'reader',
    roleNone: 'user with no role',
    width: 'Sidebar width',
    widthValue: (rem: string) => `${rem} rem wide`,
    resizeHint: 'Drag to resize. Double-click to reset.',
  },
});

export const ACCOUNT_MENU_WORDS = defineWords({
  id: 'shell-account-menu',
  en: {
    settings: 'Settings',
    language: 'Language',
    english: 'English',
    currentLanguage: 'Current language',
    help: 'Help',
    getHelp: 'Get help',
    sendFeedback: 'Send feedback',
    reportBug: 'Report a bug',
    theme: 'Theme',
    themeAuto: 'Auto',
    themeAutoName: 'Auto (match this device)',
    themeLight: 'Light',
    themeDark: 'Dark',
    learnMore: 'Learn more',
    changelog: 'View changelog',
    securityPolicy: 'Security policy',
    codeOfConduct: 'Code of conduct',
    license: 'License',
    signOut: 'Sign out',
  },
});

export const FRAME_WORDS = defineWords({
  id: 'shell-frame',
  en: {
    loadingPage: 'Loading page…',
  },
});
