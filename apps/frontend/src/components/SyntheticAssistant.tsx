import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowUp, BookOpen, ChevronDown, FileText, RotateCcw, Square } from 'lucide-react';
import { useAuth } from '@/auth/AuthProvider';
import { WRITER_ROLES } from '@/auth/roles';
import { MascotWelcome } from '@/components/MascotWelcome';
import { ContextDrawer } from '@/components/ui/ContextDrawer';
import { Button } from '@/components/ui/Button';
import { PromptInput } from '@/components/prompt-kit/PromptInput';
import { PromptInputTextarea } from '@/components/prompt-kit/PromptInputTextarea';
import { PromptSuggestion } from '@/components/prompt-kit/PromptSuggestion';
import { Message } from '@/components/prompt-kit/Message';
import { MessageContent } from '@/components/prompt-kit/MessageContent';
import { SystemMessage } from '@/components/prompt-kit/SystemMessage';
import { ThinkingBar } from '@/components/prompt-kit/ThinkingBar';
import { Tool } from '@/components/prompt-kit/Tool';
import { Reasoning } from '@/components/prompt-kit/Reasoning';
import { Source } from '@/components/prompt-kit/Source';
import { SourceTrigger } from '@/components/prompt-kit/SourceTrigger';
import { ResponseBasis } from '@/components/ResponseBasis';
import { FeedbackBar } from '@/components/prompt-kit/FeedbackBar';
import { ScrollButton } from '@/components/prompt-kit/ScrollButton';
import { FileUpload } from '@/components/prompt-kit/FileUpload';
import { Image } from '@/components/prompt-kit/Image';
import { DEMO_QUESTIONS } from '@/lib/interpretationDemo';
import { ownedStorageMode } from '@/lib/storageMode';
import { useSyntheticChat } from '@/hooks/useSyntheticChat';
import { ProgressiveBlur } from '@/components/motion-primitives/ProgressiveBlur';
import '@/styles/interpretation-preview.css';

const STAGES = ['Starting sample preview…', 'Preparing sample preview…', 'Finishing sample preview…'];

export function SyntheticAssistant({ embedded = false, workspace = false }: { embedded?: boolean; workspace?: boolean }) {
  const { roles } = useAuth();
  const allowed = import.meta.env.DEV && location.hostname === '127.0.0.1';
  const { input, setInput, turns, pending, stage, status, error, full, failNext, setFailNext, submit: send, retry, cancel: stop, markFeedback } = useSyntheticChat(allowed);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [sourceRequested, setSourceRequested] = useState(false);
  const [session, setSession] = useState(0);
  const [showLatest, setShowLatest] = useState(false);
  const conversation = useRef<HTMLDivElement>(null);
  const latest = useRef<HTMLDivElement>(null);
  const questionMenu = useRef<HTMLDetailsElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const hasExchange = useRef(false);
  const canAttach = roles.some((role) => WRITER_ROLES.includes(role));
  useEffect(() => {
    hasExchange.current = Boolean(turns.length || pending || error);
    if (followLatest.current && conversation.current) conversation.current.scrollTop = hasExchange.current ? conversation.current.scrollHeight : 0;
  }, [turns, pending, stage, error]);
  useEffect(() => {
    if (!content.current || !conversation.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const region = conversation.current;
      if (!region) return;
      if (followLatest.current) region.scrollTop = hasExchange.current ? region.scrollHeight : 0;
      setShowLatest(hasExchange.current && region.scrollHeight - region.scrollTop - region.clientHeight >= 32);
    });
    observer.observe(content.current);
    return () => observer.disconnect();
  }, []);
  function focusInput() {
    document.getElementById('demo-question')?.focus();
  }
  function scrollToLatest() {
    followLatest.current = true;
    latest.current?.focus({ preventScroll: true });
    if (conversation.current) conversation.current.scrollTop = conversation.current.scrollHeight;
    setShowLatest(false);
  }
  async function cancel() {
    await stop();
    focusInput();
  }
  async function reset() {
    await stop(true);
    followLatest.current = true;
    setShowLatest(false);
    setSession((current) => current + 1);
    if (embedded || workspace) focusInput();
    else document.getElementById('explanation-heading')?.focus();
  }
  function submit(question: string) {
    followLatest.current = true;
    setShowLatest(false);
    void send(question);
  }
  function dismissQuestions(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && questionMenu.current) {
      event.preventDefault();
      questionMenu.current.open = false;
      questionMenu.current.querySelector('summary')?.focus();
    }
  }
  if (!allowed)
    return (
      <div>
        <h1 className="text-2xl">Preview unavailable</h1>
        <p className="mt-3">This demonstration is available only on the local development server at 127.0.0.1.</p>
      </div>
    );

  return (
    <div className={workspace ? 'chat-workspace flex min-w-0 flex-col gap-4' : 'flex min-w-0 flex-col gap-5'}>
      {!embedded && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 max-w-full flex-1 wrap-anywhere">
            {!workspace && <p className="mb-1 text-xs font-semibold text-muted-foreground">REPORTS / DESIGN PREVIEW</p>}
            <h1 className="text-3xl tracking-tight">{workspace ? 'Chat workspace' : 'PGx interpretation workspace'}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{workspace ? 'Bundled example · No patient linked' : 'Evidence in view. Explanations with context.'}</p>
          </div>
          {workspace ? (
            <Button
              variant="outline"
              aria-label="Report details & evidence"
              title="Report details & evidence"
              onClick={() => {
                setSourceRequested(false);
                setEvidenceOpen(true);
              }}
            >
              <BookOpen aria-hidden="true" className="size-4" />
              <span className="hidden sm:inline">Report details &amp; evidence</span>
            </Button>
          ) : (
            <Button asChild variant="ghost" size="sm">
              <Link to={ownedStorageMode() ? '/reports' : '/'}>
                <ArrowLeft aria-hidden="true" className="size-4" />
                {ownedStorageMode() ? 'Back to reports' : 'Back to overview'}
              </Link>
            </Button>
          )}
        </div>
      )}
      {!embedded && (
        <SystemMessage label={workspace ? 'System' : undefined} quiet={workspace}>
          <strong>Synthetic demonstration only.</strong> Fixed responses; no live AI or clinical interpretation. {!workspace && 'No selected patient or report is connected.'}
        </SystemMessage>
      )}
      <div className={workspace ? 'chat-grid min-w-0' : embedded ? 'flex min-w-0 flex-col gap-4' : 'grid min-w-0 items-start gap-5 lg:grid-cols-3'}>
        <section
          aria-label={workspace ? 'AI-assisted explanation' : undefined}
          aria-labelledby={workspace ? undefined : 'explanation-heading'}
          className={
            workspace
              ? 'chat-surface min-w-0 overflow-hidden rounded-lg border border-divider bg-panel'
              : embedded
                ? 'min-w-0 bg-panel'
                : 'min-w-0 overflow-hidden rounded-lg border border-divider bg-panel shadow-panel lg:order-2 lg:col-span-2'
          }
        >
          {embedded ? (
            <h2 id="explanation-heading" tabIndex={-1} className="sr-only">
              AI-assisted explanation
            </h2>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-divider px-5 py-4">
              <div>
                <h2 id="explanation-heading" tabIndex={-1} className="text-xl">
                  {workspace ? 'Conversation' : 'AI-assisted explanation'}
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">Synthetic conversation · this session only</p>
              </div>
              <Button variant="ghost" size="sm" onClick={reset}>
                <RotateCcw aria-hidden="true" className="size-4" />
                Reset
              </Button>
            </div>
          )}
          {/* The full chat fades messages under a fixed top edge; the small embedded preview has no room for one. */}
          <div className={workspace ? 'conversation-frame' : 'contents'}>
            <div
              ref={conversation}
              role="region"
              aria-label="Explanation conversation"
              tabIndex={0}
              className={`preview-conversation ${embedded ? 'p-2' : 'p-4 sm:p-6'}`}
              onScroll={(event) => {
                const el = event.currentTarget;
                const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
                followLatest.current = !hasExchange.current || atBottom;
                setShowLatest(hasExchange.current && !atBottom);
              }}
            >
              <div ref={content}>
                {!turns.length && !pending && !error && (
                  <MascotWelcome context="assistant">
                    {!embedded && !workspace && <p className="text-xs font-semibold text-muted-foreground">TELESPHOROS</p>}
                    <h3 className={embedded ? 'text-sm' : 'mt-2 text-2xl tracking-tight'}>Understand the evidence.</h3>
                    <p className={embedded ? 'mt-1 text-xs text-muted-foreground' : 'mt-3 max-w-prose text-sm leading-relaxed text-muted-foreground'}>
                      {workspace
                        ? 'Start with a sample question to explore the interface.'
                        : embedded
                          ? 'Choose a sample question.'
                          : 'Explore a finding, inspect its sources, and see what is still missing. Start with a sample question below.'}
                    </p>
                    {!embedded && !workspace && (
                      <div className="mt-6 flex items-center gap-2 text-xs text-muted-foreground">
                        <BookOpen aria-hidden="true" className="size-4" />
                        Explanations support review; they do not establish approval.
                      </div>
                    )}
                  </MascotWelcome>
                )}
                <ol className="space-y-7" aria-label="Sample exchanges">
                  {turns.map((turn) => (
                    <li key={turn.id}>
                      <Message className="mb-5 justify-end">
                        <MessageContent className="max-w-prose bg-background">
                          <p className="mb-1 text-xs font-semibold text-muted-foreground">You · sample question</p>
                          <p>{turn.question}</p>
                        </MessageContent>
                      </Message>
                      <Message>
                        <div className="min-w-0 w-full">
                          <p className="mb-3 border-l-2 border-primary pl-3 text-sm font-semibold">
                            Telesphoros <span className="ml-2 font-normal text-muted-foreground">/ sample explanation</span>
                          </p>
                          {workspace ? <ResponseBasis question={turn.question} /> : <Tool toolPart={{ state: 'output-available', stage: 3 }} />}
                          <div className="py-4 text-sm leading-relaxed">
                            <p>{turn.answer}</p>
                            <p className="mt-3 text-xs text-muted-foreground">Fixed demonstration copy · not model output</p>
                          </div>
                          {workspace ? (
                            <SourceTrigger
                              onClick={() => {
                                setSourceRequested(true);
                                setEvidenceOpen(true);
                              }}
                            />
                          ) : (
                            <>
                              <Reasoning>
                                This response was selected from a fixed sample using the question label. No uploaded content or clinical evidence was assessed, and no model
                                reasoning occurred.
                              </Reasoning>
                              <Source />
                            </>
                          )}
                          <FeedbackBar value={turn.feedback} onChange={(value) => markFeedback(turn.id, value)} />
                        </div>
                      </Message>
                    </li>
                  ))}
                </ol>
                {pending && (
                  <div className="mt-5 space-y-4" aria-busy="true">
                    <Message className="justify-end">
                      <MessageContent className="bg-background">
                        <p className="mb-1 text-xs font-semibold">You · sample question</p>
                        <p>{pending}</p>
                      </MessageContent>
                    </Message>
                    <ThinkingBar text={STAGES[stage]} stage={stage} onStop={cancel} />
                    {!workspace && <Tool key="pending-tool" toolPart={{ state: stage === 0 ? 'input-streaming' : 'input-available', stage }} defaultOpen />}
                    <div aria-hidden="true" className="space-y-3 py-2 motion-safe:animate-pulse">
                      <div className="h-2 w-3/4 rounded-sm bg-divider" />
                      <div className="h-2 w-full rounded-sm bg-divider" />
                    </div>
                  </div>
                )}
                {error && (
                  <div className="mt-4 space-y-3">
                    <SystemMessage error>{error}</SystemMessage>
                    <Tool toolPart={{ state: 'output-error', stage }} />
                    <Button
                      variant="outline"
                      className="h-auto min-h-control max-w-full whitespace-normal"
                      onClick={() => {
                        followLatest.current = true;
                        void retry();
                        focusInput();
                      }}
                    >
                      Retry sample response
                    </Button>
                  </div>
                )}
                <div ref={latest} role="group" tabIndex={-1} aria-label="End of conversation" className="mt-2" />
              </div>
            </div>
            {workspace && <ProgressiveBlur edge="top" />}
          </div>
          {embedded || workspace ? (
            <div className="assistant-footer border-t border-divider bg-panel pt-2">
              <div className="mb-2 flex flex-wrap items-center gap-1" aria-label="Sample questions">
                <PromptSuggestion aria-label={DEMO_QUESTIONS[0]} aria-disabled={!!pending || full} onClick={() => submit(DEMO_QUESTIONS[0])}>
                  {workspace ? 'Explain this example' : 'Explain'}
                </PromptSuggestion>
                <details ref={questionMenu} className="assistant-question-menu">
                  <summary aria-label="More questions" onKeyDown={dismissQuestions} className="flex min-h-control cursor-pointer items-center gap-1 px-2 text-sm font-medium">
                    Questions
                    <ChevronDown aria-hidden="true" className="size-3" />
                  </summary>
                  <div className="flex flex-col gap-2 rounded-lg border border-divider bg-panel p-2 shadow-panel">
                    {DEMO_QUESTIONS.slice(1).map((question) => (
                      <PromptSuggestion
                        key={question}
                        aria-label={question}
                        aria-disabled={!!pending || full}
                        onKeyDown={dismissQuestions}
                        onClick={() => {
                          submit(question);
                          if (questionMenu.current) questionMenu.current.open = false;
                          focusInput();
                        }}
                      >
                        {question}
                      </PromptSuggestion>
                    ))}
                  </div>
                </details>
                {!workspace && (
                  <Button variant="ghost" size="sm" aria-label="Reset" title="Reset" onClick={reset}>
                    <RotateCcw aria-hidden="true" className="size-4" />
                  </Button>
                )}
              </div>
              {showLatest && (
                <div className="assistant-latest">
                  <ScrollButton compact onClick={scrollToLatest} />
                </div>
              )}
              <PromptInput className="assistant-composer p-2" value={input} onValueChange={setInput} isLoading={!!pending} disabled={full} onSubmit={() => submit(input)}>
                <label htmlFor="demo-question" className="sr-only">
                  Sample question
                </label>
                <div className="flex items-start gap-2">
                  <PromptInputTextarea
                    id="demo-question"
                    rows={1}
                    maxLength={400}
                    placeholder="Ask about the synthetic example…"
                    aria-describedby="demo-question-help"
                    onFocus={() => {
                      if (questionMenu.current) questionMenu.current.open = false;
                    }}
                  />
                  <Button
                    aria-label={pending ? 'Stop' : 'Send sample'}
                    title={pending ? 'Stop' : 'Send sample'}
                    type={pending ? 'button' : 'submit'}
                    disabled={!pending && (!input.trim() || full)}
                    onClick={
                      pending
                        ? (event) => {
                            event.preventDefault();
                            cancel();
                          }
                        : undefined
                    }
                  >
                    {pending ? <Square aria-hidden="true" className="size-4" /> : <ArrowUp aria-hidden="true" className="size-4" />}
                  </Button>
                </div>
                <p id="demo-question-help" className="mt-1 text-xs text-muted-foreground">
                  Synthetic text only. Enter to send.
                </p>
              </PromptInput>
              <p role="status" className="sr-only">
                {full ? 'Six sample exchanges reached. Reset to continue.' : status}
              </p>
              {full && <p className="mt-1 text-xs text-muted-foreground">Six sample exchanges reached. Reset to continue.</p>}
            </div>
          ) : (
            <div className="border-t border-divider bg-panel p-4 sm:px-5">
              <div className="mb-3 flex min-h-6 flex-wrap items-center justify-between gap-2">
                <p role="status" className="text-xs text-muted-foreground">
                  {full ? 'Six sample exchanges reached. Reset to continue.' : status}
                </p>
                {showLatest && <ScrollButton onClick={scrollToLatest} />}
              </div>
              <div className={`mb-3 grid gap-2 ${embedded ? '' : 'sm:grid-cols-3'}`} aria-label="Sample questions">
                {DEMO_QUESTIONS.map((question) => (
                  <PromptSuggestion key={question} aria-label={question} aria-disabled={!!pending || full} onClick={() => submit(question)}>
                    {question}
                  </PromptSuggestion>
                ))}
              </div>
              <PromptInput value={input} onValueChange={setInput} isLoading={!!pending} disabled={full} onSubmit={() => submit(input)}>
                <label htmlFor="demo-question" className="block px-3 pt-1 text-sm font-semibold">
                  Sample question
                </label>
                <PromptInputTextarea
                  id="demo-question"
                  rows={1}
                  maxLength={400}
                  placeholder="Ask about the example or choose a suggestion…"
                  aria-describedby="demo-question-help"
                />
                <div className="mt-2 flex flex-col items-stretch gap-3 border-t border-divider pt-3 sm:flex-row sm:items-center sm:justify-between">
                  <p id="demo-question-help" className="min-w-0 flex-1 text-xs text-muted-foreground">
                    Synthetic text only. Enter to send.
                    <br />
                    Shift+Enter for a new line. Nothing is sent or saved.
                  </p>
                  <Button
                    type={pending ? 'button' : 'submit'}
                    disabled={!pending && (!input.trim() || full)}
                    onClick={
                      pending
                        ? (event) => {
                            event.preventDefault();
                            cancel();
                          }
                        : undefined
                    }
                  >
                    {pending ? (
                      <>
                        <Square aria-hidden="true" className="size-4" />
                        Stop
                      </>
                    ) : (
                      <>
                        <ArrowUp aria-hidden="true" className="size-4" />
                        Send sample
                      </>
                    )}
                  </Button>
                </div>
              </PromptInput>
            </div>
          )}
        </section>
        {workspace ? (
          <ContextDrawer
            id="chat-evidence"
            title="Report details & evidence"
            open={evidenceOpen}
            onClose={() => {
              setEvidenceOpen(false);
              setSourceRequested(false);
            }}
          >
            <p className="mb-4 text-sm text-muted-foreground">Bundled synthetic example only. This drawer does not contain a selected patient's report or clinical evidence.</p>
            {turns.length > 0 && <Source key={sourceRequested ? 'response' : 'context'} defaultOpen={sourceRequested} />}
            <aside aria-label="Example report context" className="flex min-w-0 flex-col gap-4 lg:order-1">
              <section aria-labelledby="example-heading" className="rounded-lg border border-divider bg-panel p-5">
                <div className="mb-4 flex items-center gap-3">
                  <FileText aria-hidden="true" className="size-5" />
                  <h2 id="example-heading" className="text-base">
                    Source material
                  </h2>
                </div>
                <p className="font-semibold">SYN-PGX-UI-01</p>
                <p className="mt-1 text-xs text-muted-foreground">Fictional report context · revision 1</p>
                <dl className="my-5 divide-y divide-divider text-sm">
                  <div className="flex flex-wrap justify-between gap-2 py-3">
                    <dt className="text-muted-foreground">Genotype / phenotype</dt>
                    <dd>Not evaluated</dd>
                  </div>
                  <div className="flex flex-wrap justify-between gap-2 py-3">
                    <dt className="text-muted-foreground">Guideline result</dt>
                    <dd>Not evaluated</dd>
                  </div>
                  <div className="flex flex-wrap justify-between gap-2 py-3">
                    <dt className="text-muted-foreground">Clinical review</dt>
                    <dd>Not performed</dd>
                  </div>
                </dl>
                <Image />
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Image is a separate bundled synthetic fixture. No image or report is analyzed.</p>
              </section>
              <FileUpload key={session} canAttach={canAttach} busy={!!pending} />
              <details className="rounded-lg border border-divider bg-panel px-4">
                <summary className="min-h-control cursor-pointer py-3 text-sm font-semibold">Preview controls</summary>
                <p className="mb-3 text-xs text-muted-foreground">Simulate the next response failing, then try recovery.</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mb-4 h-auto min-h-control max-w-full whitespace-normal"
                  aria-pressed={failNext}
                  disabled={!!pending || full}
                  onClick={() => setFailNext((value) => !value)}
                >
                  {failNext ? 'Simulated failure armed' : 'Simulate next response failure'}
                </Button>
              </details>
            </aside>
            {(pending || turns.length > 0 || error) && (
              <Tool toolPart={{ state: error ? 'output-error' : pending ? 'input-available' : 'output-available', stage: pending || error ? stage : 3 }} />
            )}
          </ContextDrawer>
        ) : (
          <>
            {' '}
            <details open={!embedded} className={embedded ? 'border-t border-divider bg-panel' : 'contents'}>
              <summary className={embedded ? 'min-h-control cursor-pointer py-3 text-sm font-semibold' : 'hidden'}>Example context and tools</summary>
              <aside aria-label="Example report context" className="flex min-w-0 flex-col gap-4 lg:order-1">
                <section aria-labelledby="example-heading" className="rounded-lg border border-divider bg-panel p-5">
                  <div className="mb-4 flex items-center gap-3">
                    <FileText aria-hidden="true" className="size-5" />
                    <h2 id="example-heading" className="text-base">
                      Source material
                    </h2>
                  </div>
                  <p className="font-semibold">SYN-PGX-UI-01</p>
                  <p className="mt-1 text-xs text-muted-foreground">Fictional report context · revision 1</p>
                  <dl className="my-5 divide-y divide-divider text-sm">
                    <div className="flex flex-wrap justify-between gap-2 py-3">
                      <dt className="text-muted-foreground">Genotype / phenotype</dt>
                      <dd>Not evaluated</dd>
                    </div>
                    <div className="flex flex-wrap justify-between gap-2 py-3">
                      <dt className="text-muted-foreground">Guideline result</dt>
                      <dd>Not evaluated</dd>
                    </div>
                    <div className="flex flex-wrap justify-between gap-2 py-3">
                      <dt className="text-muted-foreground">Clinical review</dt>
                      <dd>Not performed</dd>
                    </div>
                  </dl>
                  <Image />
                  <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Image is a separate bundled synthetic fixture. No image or report is analyzed.</p>
                </section>
                <FileUpload key={session} canAttach={canAttach} busy={!!pending} />
                <details className="rounded-lg border border-divider bg-panel px-4">
                  <summary className="min-h-control cursor-pointer py-3 text-sm font-semibold">Preview controls</summary>
                  <p className="mb-3 text-xs text-muted-foreground">Simulate the next response failing, then try recovery.</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mb-4 h-auto min-h-control max-w-full whitespace-normal"
                    aria-pressed={failNext}
                    disabled={!!pending || full}
                    onClick={() => setFailNext((value) => !value)}
                  >
                    {failNext ? 'Simulated failure armed' : 'Simulate next response failure'}
                  </Button>
                </details>
              </aside>
              {embedded && (
                <div className="pb-2">
                  <p className="my-2 text-xs text-muted-foreground">Shift+Enter inserts a new line. Nothing is sent or saved.</p>
                  <Button asChild variant="ghost" size="sm">
                    <Link to="/local-interpretation">Open full preview</Link>
                  </Button>
                </div>
              )}
            </details>
          </>
        )}
      </div>
    </div>
  );
}
