import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setAppLanguage, type AppLanguage } from '@/lib/appLanguage';
import { formatIn, useFormat, when } from '@/lib/formatWhen';
import { defineWords } from '@/lib/words/defineWords';
import { useWords, type Screen } from '@/lib/words/screens';
import { renderApp } from '@/test/authTestUtils';
import { ScreenLanguage } from './ScreenLanguage';

// Spec 050 LS1: a screen shows Spanish only when the app is in Spanish and the screen is listed as translated (R5); every other screen stays wholly
// English, marked lang="en" (R6); dates follow a translated screen's language and the browser's locale elsewhere (R11); <html lang> follows the
// app's language on every page but the landing (R3). The landing's own <html lang> is covered by e2e/landing-language.spec.ts.

const TABLE = defineWords({ id: 'test-screen', en: { hello: 'Hello' }, es: { hello: 'Hola' } });
const ISO = '2026-03-14T15:09:00.000Z';

function Probe() {
  const words = useWords(TABLE);
  const format = useFormat();
  return (
    <p data-testid="probe">
      {words.hello} · {format.when(ISO)}
    </p>
  );
}

const translatedHome: ReadonlySet<Screen> = new Set<Screen>(['home']);
const none: ReadonlySet<Screen> = new Set<Screen>();
const probe = () => screen.getByTestId('probe');
/** The screen's root element, which takes the `lang` ScreenLanguage gives it. */
const root = () => screen.getByTestId('root');

function inScreen(props: { screen: Screen | undefined; inherits?: AppLanguage; translated: ReadonlySet<Screen> }) {
  return render(
    <ScreenLanguage {...props}>
      {(lang) => (
        <div lang={lang} data-testid="root">
          <Probe />
        </div>
      )}
    </ScreenLanguage>,
  );
}

afterEach(() => act(() => setAppLanguage('en')));

describe('one screen in the app language', () => {
  it('in English, shows English and marks nothing', () => {
    inScreen({ screen: 'home', translated: translatedHome });
    expect(probe()).toHaveTextContent('Hello');
    expect(root()).not.toHaveAttribute('lang');
  });

  it('in Spanish, a translated screen shows Spanish, with dates in es-PR, and marks nothing (it inherits the page language)', () => {
    setAppLanguage('es');
    inScreen({ screen: 'home', translated: translatedHome });
    expect(probe()).toHaveTextContent(`Hola · ${formatIn('es-PR').when(ISO)}`);
    expect(root()).not.toHaveAttribute('lang');
  });

  it('in Spanish, an untranslated screen stays wholly English, marked lang="en", with dates in the browser locale as before', () => {
    setAppLanguage('es');
    inScreen({ screen: 'home', translated: none });
    expect(probe()).toHaveTextContent(`Hello · ${when(ISO)}`);
    expect(root()).toHaveAttribute('lang', 'en');
  });

  it('a route with no screen name is untranslated', () => {
    setAppLanguage('es');
    inScreen({ screen: undefined, translated: translatedHome });
    expect(probe()).toHaveTextContent('Hello');
    expect(root()).toHaveAttribute('lang', 'en');
  });

  it('a translated screen inside an English frame is marked with its own lang="es"', () => {
    setAppLanguage('es');
    inScreen({ screen: 'home', inherits: 'en', translated: translatedHome });
    expect(probe()).toHaveTextContent('Hola');
    expect(root()).toHaveAttribute('lang', 'es');
  });

  it('outside any screen, words are English and dates keep the browser locale', () => {
    setAppLanguage('es');
    render(<Probe />);
    expect(probe()).toHaveTextContent(`Hello · ${when(ISO)}`);
  });
});

describe('<html lang> on the app (R3), with no screen translated yet (LS1)', () => {
  it('is "en" with English chosen', async () => {
    renderApp('/signed-out');
    expect(await screen.findByRole('heading', { level: 1, name: 'You have been signed out' })).toBeVisible();
    await waitFor(() => expect(document.documentElement.lang).toBe('en'));
  });

  it('is "es" with Spanish chosen, and every untranslated screen, the frame included, says lang="en" and stays English', async () => {
    setAppLanguage('es');
    renderApp('/signed-out');
    const heading = await screen.findByRole('heading', { level: 1, name: 'You have been signed out' });
    await waitFor(() => expect(document.documentElement.lang).toBe('es'));
    expect(heading.closest('[lang]')).toHaveAttribute('lang', 'en');
    expect(document.querySelector('.app-frame')).toHaveAttribute('lang', 'en');
  });
});
