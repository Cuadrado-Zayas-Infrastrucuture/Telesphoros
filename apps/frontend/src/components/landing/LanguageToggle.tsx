import { useLandingLanguage } from '@/lib/landing/landing-language';

/** One button that names the other language, in that language (its `lang` is set so screen readers pronounce it). */
export function LanguageToggle() {
  const { language, copy, setLanguage } = useLandingLanguage();
  const target = language === 'en' ? 'es' : 'en';
  return (
    <button
      type="button"
      lang={copy.language.switchLang}
      onClick={() => setLanguage(target)}
      className="landing-language-toggle inline-flex min-h-control items-center px-2 text-sm font-medium hover:bg-muted"
    >
      {copy.language.switchTo}
    </button>
  );
}
