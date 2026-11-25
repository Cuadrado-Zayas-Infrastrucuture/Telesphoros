import { defineWords } from './defineWords';

/*
 * The `sign-in` screen's fixed words (spec 050 LS2a): /signin, /signed-out and /auth/callback. English only until the founders' Spanish (LS2b).
 * Interface strings, not clinical (LS2-D4).
 */

export const SIGN_IN_WORDS = defineWords({
  id: 'sign-in',
  en: {
    title: 'Sign in',
    heading: 'Sign in',
    intro: 'You will be taken to the secure sign-in page. Accounts are by invitation only: if you need access, ask your administrator.',
    unreachable: 'Could not reach the sign-in page',
    checkConnection: 'Check your connection and try again.',
    button: 'Sign in',
    redirecting: 'Redirecting…',
  },
});

export const SIGNED_OUT_WORDS = defineWords({
  id: 'signed-out',
  en: {
    title: 'Signed out',
    heading: 'You have been signed out',
    body: 'Close this window, or sign in again to continue.',
    signIn: 'Sign in',
  },
});

export const CALLBACK_WORDS = defineWords({
  id: 'sign-in-callback',
  en: {
    title: 'Signing you in',
    heading: 'Signing you in',
    wait: 'Please wait…',
    accountHeading: 'Your account is not set up yet',
    accountTitle: 'No organization is assigned to your account',
    accountBody:
      'You signed in successfully, but your account does not belong to an organization yet. Ask your administrator to add you to one. Trying again will not help until they do.',
    failedHeading: 'Sign-in did not complete',
    failedTitle: 'We could not sign you in',
    failedBody: 'The sign-in link may have expired or been used already. Please try again.',
    tryAgain: 'Try again',
  },
});
