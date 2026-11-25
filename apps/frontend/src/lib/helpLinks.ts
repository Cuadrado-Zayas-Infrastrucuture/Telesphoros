/**
 * Where the account menu's help and policy entries lead (specs/034 D10): the public repository's own community files and issue forms.
 * There is no privacy policy or terms of service yet, so the menu names none; add them here once they exist.
 */
const REPOSITORY = 'https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros';
const file = (name: string) => `${REPOSITORY}/blob/main/${name}`;

export const HELP_LINKS = {
  help: file('SUPPORT.md'),
  feedback: `${REPOSITORY}/issues/new?template=feature_request.yml`,
  bug: `${REPOSITORY}/issues/new?template=bug_report.yml`,
  changelog: file('CHANGELOG.md'),
} as const;

/** Each entry names its words in `ACCOUNT_MENU_WORDS` (`lib/words/shell.ts`), so the menu shows them in the shell's language. */
export const POLICY_LINKS: readonly { word: 'securityPolicy' | 'codeOfConduct' | 'license'; href: string }[] = [
  { word: 'securityPolicy', href: file('SECURITY.md') },
  { word: 'codeOfConduct', href: file('CODE_OF_CONDUCT.md') },
  { word: 'license', href: file('LICENSE') },
];
