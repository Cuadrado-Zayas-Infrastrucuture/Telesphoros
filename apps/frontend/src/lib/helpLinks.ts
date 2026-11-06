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

export const POLICY_LINKS: readonly { label: string; href: string }[] = [
  { label: 'Security policy', href: file('SECURITY.md') },
  { label: 'Code of conduct', href: file('CODE_OF_CONDUCT.md') },
  { label: 'License', href: file('LICENSE') },
];
