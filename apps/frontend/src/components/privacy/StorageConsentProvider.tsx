import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { ContextDrawer } from '@/components/ui/ContextDrawer';
import { Label } from '@/components/ui/Label';
import { useLandingLanguage, useLandingRoute } from '@/lib/landing/landing-language';
import { preferenceStorage } from '@/lib/storageConsent';
import type { ConsentSnapshot } from '@/lib/storageConsent';
import '@/styles/storage-consent.css';

const EN = {
  title: 'Cookies and browser storage',
  message: 'Optional storage remembers display and language settings. Sign-in and upload recovery use required session storage.',
  necessary: 'Use necessary only',
  allow: 'Allow preferences',
  manage: 'Manage',
  reopen: 'Cookie settings',
  close: 'Close cookie settings',
  requiredTitle: 'Required app storage',
  required: 'Sign-in state and unfinished-upload recovery stay available. Your sign-in provider manages its own session.',
  always: 'Always on',
  optional: 'Remember display and language settings',
  optionalHelp: 'Optional: save your theme, sidebar layout and landing-page language on this device. Without this, choices still work for this tab.',
  scope: 'These controls cover saved browser preferences. They do not change application record events.',
  save: 'Save choices',
  temporary: 'This browser could not save the decision. It applies to this tab only.',
  clearProblem: 'Your choice applies now, but this browser prevented clearing saved preferences. Use its site-data controls to remove them.',
};
const ES: typeof EN = {
  title: 'Cookies y almacenamiento del navegador',
  message: 'El almacenamiento opcional recuerda la apariencia y el idioma. El inicio de sesión y la recuperación de cargas usan almacenamiento de sesión requerido.',
  necessary: 'Solo lo necesario',
  allow: 'Permitir preferencias',
  manage: 'Configurar',
  reopen: 'Opciones de cookies',
  close: 'Cerrar opciones de cookies',
  requiredTitle: 'Almacenamiento requerido',
  required: 'El inicio de sesión y la recuperación de cargas permanecen disponibles. El proveedor de acceso administra su propia sesión.',
  always: 'Siempre activo',
  optional: 'Recordar apariencia e idioma',
  optionalHelp: 'Opcional: guardar el tema, el panel lateral y el idioma de la página principal en este dispositivo. Sin esto, las opciones siguen funcionando en esta pestaña.',
  scope: 'Estos controles cubren las preferencias del navegador. No cambian los eventos de registros de la aplicación.',
  save: 'Guardar opciones',
  temporary: 'El navegador no pudo guardar la decisión. Solo se aplica a esta pestaña.',
  clearProblem: 'La decisión se aplica ahora, pero el navegador impidió borrar preferencias guardadas. Usa sus controles de datos del sitio para eliminarlas.',
};

const ConsentContext = createContext<{ snapshot: ConsentSnapshot; openPreferences: () => void; reopenLabel: string } | null>(null);
export function useStorageConsent() {
  const value = useContext(ConsentContext);
  if (!value) throw new Error('Storage consent controls require StorageConsentProvider.');
  return value;
}

/** Mount once in the app layout. Only optional display preferences are gated; the initial bar never blocks sign-in. */
export function StorageConsentProvider({ children }: { children: ReactNode }) {
  const snapshot = useSyncExternalStore(preferenceStorage.subscribe, preferenceStorage.getSnapshot, preferenceStorage.getServerSnapshot);
  const landing = useLandingRoute();
  const { language } = useLandingLanguage();
  const copy = landing && language === 'es' ? ES : EN;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(false);
  const [problem, setProblem] = useState<'clear' | 'temporary' | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const returnToPage = useRef(false);
  const showBar = snapshot.preferences === null && !open;
  const openPreferences = useCallback(() => {
    setDraft(snapshot.preferences === true);
    setProblem(null);
    setOpen(true);
  }, [snapshot.preferences]);
  const context = useMemo(() => ({ snapshot, openPreferences, reopenLabel: copy.reopen }), [snapshot, openPreferences, copy.reopen]);

  useLayoutEffect(() => {
    const node = bar.current;
    if (!showBar || !node) return;
    const root = document.documentElement;
    root.dataset.storageConsentPending = 'true';
    const measure = () => root.style.setProperty('--size-consent-space', `${Math.ceil(node.getBoundingClientRect().height) + 32}px`);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      root.style.removeProperty('--size-consent-space');
      delete root.dataset.storageConsentPending;
    };
  }, [showBar]);

  useEffect(() => {
    if (!returnToPage.current || snapshot.preferences === null || open) return;
    // Native modal closure must finish before the formerly inert page can receive focus.
    const frame = window.requestAnimationFrame(() => {
      returnToPage.current = false;
      document.getElementById('main')?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [snapshot, open]);

  function save(preferences: boolean) {
    if (snapshot.preferences === null) returnToPage.current = true;
    const result = preferenceStorage.choose(preferences);
    setDraft(preferences);
    setProblem(!result.cleared ? 'clear' : !result.persisted ? 'temporary' : null);
    setOpen(!result.cleared || !result.persisted);
  }

  return (
    <ConsentContext.Provider value={context}>
      {children}
      {snapshot.preferences === null && (
        <div ref={bar} hidden={open} role="region" aria-labelledby="storage-consent-title" className="storage-consent-bar workspace-shell">
          <h2 id="storage-consent-title" className="text-base font-semibold">
            {copy.title}
          </h2>
          <p className="text-sm text-pretty text-muted-foreground">{copy.message}</p>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            <Button variant="outline" size="sm" className="h-auto min-h-control whitespace-normal py-2 sm:flex-1" onClick={() => save(false)}>
              {copy.necessary}
            </Button>
            <Button variant="outline" size="sm" className="h-auto min-h-control whitespace-normal py-2 sm:flex-1" onClick={() => save(true)}>
              {copy.allow}
            </Button>
            <Button variant="ghost" size="sm" className="col-span-2" onClick={openPreferences}>
              {copy.manage}
            </Button>
          </div>
        </div>
      )}
      <ContextDrawer
        id="storage-preferences"
        title={copy.title}
        closeLabel={copy.close}
        open={open}
        onClose={() => setOpen(false)}
        className="storage-consent-panel workspace-shell"
      >
        <div className="flex flex-col gap-5">
          <section className="flex flex-col gap-2" aria-labelledby="storage-required-title">
            <h3 id="storage-required-title" className="font-semibold">
              {copy.requiredTitle}
            </h3>
            <p className="text-sm text-muted-foreground">{copy.required}</p>
            <p className="text-sm font-medium">{copy.always}</p>
          </section>
          <div className="flex flex-col gap-2 border-t border-divider pt-4">
            <Label htmlFor="storage-optional-preferences" className="flex min-h-control items-center gap-3">
              <Checkbox id="storage-optional-preferences" aria-describedby="storage-optional-help" checked={draft} onChange={(event) => setDraft(event.target.checked)} />
              <span>{copy.optional}</span>
            </Label>
            <p id="storage-optional-help" className="text-sm text-muted-foreground">
              {copy.optionalHelp}
            </p>
          </div>
          <p className="text-sm text-muted-foreground">{copy.scope}</p>
          {!problem && snapshot.preferences !== null && !snapshot.persisted && (
            <p role="status" className="text-sm text-muted-foreground">
              {copy.temporary}
            </p>
          )}
          {problem && (
            <p role={problem === 'clear' ? 'alert' : 'status'} className={problem === 'clear' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
              {problem === 'clear' ? copy.clearProblem : copy.temporary}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => save(false)}>
              {copy.necessary}
            </Button>
            <Button onClick={() => save(draft)}>{copy.save}</Button>
          </div>
        </div>
      </ContextDrawer>
    </ConsentContext.Provider>
  );
}
