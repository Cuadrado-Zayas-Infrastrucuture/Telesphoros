import { z } from 'zod';
import { signerSchema, signersMatchStatus } from './glossary';
import helpEn from './help.en.json';
import helpEs from './help.es.json';

/**
 * Spec 051 (the curated help assistant, slice H1): the help articles. How the product works, what a screen, word or status means in
 * general, and why a control may be unavailable: the same for every patient and never about one. Each article is `draft` until two
 * pharmacists have reviewed it and are named, with the date, in `signedBy` (H-D1, as the glossary, B2-D1). The founders write the Spanish;
 * nothing is machine translated (spec 050).
 */

/** The screens an article can belong to, with their routes. `patient` has a parameter, so an article can be about it but cannot link to it. */
export const HELP_SCREENS = {
  worklist: '/workspace',
  chat: '/chat',
  patients: '/patients',
  'new-patient': '/patients/new',
  patient: '/patients/:id',
  reports: '/reports',
  upload: '/reports/upload',
  'follow-ups': '/follow-ups',
  settings: '/settings',
  usage: '/usage',
} as const;
export type HelpScreen = keyof typeof HELP_SCREENS;
const screenSchema = z.enum(Object.keys(HELP_SCREENS) as [HelpScreen, ...HelpScreen[]]);
const linkableScreenSchema = screenSchema.refine((screen) => !HELP_SCREENS[screen].includes(':'), { message: 'A link cannot name a route with a parameter.' });

/** The product's roles (packages/shared-types roles.ts, checked equal by the frontend's test). An article names the roles it is for, or "all". */
export const HELP_ROLES = ['reader', 'clinician', 'admin', 'reviewer'] as const;

/** Markup, a Markdown link or a web address: none of them belongs in an article. Links go in `links`, to the app's own screens. */
const NOT_PLAIN = /[<>]|\]\(|https?:|www\./i;
const plainText = z.string().refine((text) => text.length > 0 && !NOT_PLAIN.test(text), { message: 'Plain text only, not empty: no markup and no links.' });

export const helpArticleSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    title: plainText,
    /** A few short paragraphs. */
    body: z.array(plainText).min(1),
    screens: z.array(screenSchema).min(1),
    roles: z.union([z.literal('all'), z.array(z.enum(HELP_ROLES)).min(1)]),
    /** Words a person may type for this article, in its language. */
    keywords: z.array(z.string().min(1)),
    links: z.array(z.strictObject({ label: plainText, screen: linkableScreenSchema })),
    status: z.enum(['draft', 'signed']),
    signedBy: z.array(signerSchema),
  })
  .refine(signersMatchStatus, { message: 'A signed article names at least two pharmacists, and a draft names none.' });

export type HelpArticle = z.infer<typeof helpArticleSchema>;

/** The sentence shown, instead of any search, when a question is about a patient (spec 051 section 5, H-D6). Signed like an article. */
export const helpRefusalSchema = z
  .strictObject({
    body: plainText,
    status: z.enum(['draft', 'signed']),
    signedBy: z.array(signerSchema),
  })
  .refine(signersMatchStatus, { message: 'A signed sentence names at least two pharmacists, and a draft names none.' });

export const helpFileSchema = z
  .strictObject({
    language: z.enum(['en', 'es']),
    /** Null until it is written in this language. */
    refusal: helpRefusalSchema.nullable(),
    articles: z.array(helpArticleSchema),
  })
  .superRefine((file, context) => {
    const ids = new Set<string>();
    for (const article of file.articles) {
      if (ids.has(article.id)) context.addIssue({ code: 'custom', message: `The id ${article.id} is used twice.` });
      ids.add(article.id);
    }
  });

export type HelpFile = z.infer<typeof helpFileSchema>;

/** The ids in the Spanish file that have no English article: each Spanish article is a version of an English one. Empty when all match. */
export function untwinnedIds(en: HelpFile, es: HelpFile): string[] {
  const english = new Set(en.articles.map((article) => article.id));
  return es.articles.map((article) => article.id).filter((id) => !english.has(id));
}

/** The English help, refused at load if it breaks a rule above. */
export const HELP_EN: HelpFile = helpFileSchema.parse(helpEn);
/** The Spanish help: empty until the founders write it (H-D1). */
export const HELP_ES: HelpFile = helpFileSchema.parse(helpEs);
