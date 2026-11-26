import type { ReactNode } from 'react';
import { useAppLanguage, type AppLanguage } from '@/lib/appLanguage';
import { ScreenLanguageContext, screenLanguage, TRANSLATED_SCREENS, type Screen } from '@/lib/words/screens';

/**
 * One screen's language (spec 050 LS1, R5 and R6). Its words come from `useWords`, which reads what this provides. `children` receives the `lang` to
 * put on the screen's own root element: set only when the screen shows a language other than the one around it (`inherits`: the frame's, or the
 * page's `<html lang>`, which is the app's), so a screen reader pronounces an untranslated screen as English while the app is in Spanish.
 *
 * It adds no element: the provider stays where it is whatever the language, so a change of screen or language never remounts what is below it (the
 * signed-in frame keeps its sidebar and what it holds across pages).
 */
export function ScreenLanguage({
  screen,
  inherits,
  translated = TRANSLATED_SCREENS,
  children,
}: {
  screen: Screen | undefined;
  inherits?: AppLanguage;
  translated?: ReadonlySet<Screen>;
  children: (lang: AppLanguage | undefined) => ReactNode;
}) {
  const { language: app } = useAppLanguage();
  const value = screenLanguage(app, screen, translated);
  const around = inherits ?? app;
  return <ScreenLanguageContext.Provider value={value}>{children(value.language === around ? undefined : value.language)}</ScreenLanguageContext.Provider>;
}
