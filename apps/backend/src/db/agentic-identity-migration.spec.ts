import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lintMigration } from './migration-lint';
import { MIGRATIONS_DIR, parseCompat } from './migrator';

/**
 * Migration 0030 replaces three 0029 function bodies. It is a copy with a handful of edits, so a transcription slip is the real risk. This spec needs no
 * database: it rebuilds the expected 0030 text from the 0029 text with the edit list written out below (an oracle of its own, not the generator's
 * code), and requires the file to equal it. Anything else that differs fails here, on a fresh checkout.
 */
const up0029 = readFileSync(join(MIGRATIONS_DIR, '0029_agentic_synthetic.up.sql'), 'utf8');
const up0030 = readFileSync(join(MIGRATIONS_DIR, '0030_agentic_synthetic_identity.up.sql'), 'utf8');
const down0030 = readFileSync(join(MIGRATIONS_DIR, '0030_agentic_synthetic_identity.down.sql'), 'utf8');

const ENTRY_POINTS = ['agentic_synthetic_admit', 'agentic_synthetic_read', 'agentic_synthetic_cancel'] as const;
const SIGNATURE: Record<(typeof ENTRY_POINTS)[number], string> = {
  agentic_synthetic_admit: 'jsonb, jsonb',
  agentic_synthetic_read: 'uuid, jsonb',
  agentic_synthetic_cancel: 'uuid, jsonb',
};

/** One function as written in a migration file: from its CREATE line through `END $$;`. */
function functionText(sql: string, name: string, create: string): string {
  const start = sql.indexOf(`${create} public.${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(sql.indexOf(`${create} public.${name}(`, start + 1)).toBe(-1);
  const marker = '\nEND $$;\n';
  const end = sql.indexOf(marker, start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + marker.length - 1);
}
/** What PostgreSQL stores as prosrc: the text between the dollar quotes. */
const prosrc = (fn: string) => fn.slice(fn.indexOf('AS $$') + 5, fn.lastIndexOf('$$;'));
const md5 = (text: string) => createHash('md5').update(text, 'utf8').digest('hex');

const DECLARE_OLD = "  v_tenant text := nullif(current_setting('app.current_tenant_id', true), '');\n  v_actor text := nullif(current_setting('app.current_actor', true), '');\n";
const DECLARE_NEW = '  v_tenant text;\n  v_actor text;\n';
const BEGIN_NEW = '\nBEGIN\n  SELECT i.tenant_id, i.actor INTO v_tenant, v_actor FROM public.agentic_synthetic_identity() i;\n';
const ENQUEUE_GUARD = "  IF v_job_id IS NULL OR NOT v_job_created THEN\n    RAISE EXCEPTION 'Synthetic enqueue invariant failed.' USING ERRCODE = 'integrity_constraint_violation';\n  END IF;\n";
const IDENTITY_GUARD = "  IF NOT EXISTS (SELECT 1 FROM public.jobs j WHERE j.id = v_job_id AND j.tenant_id = v_tenant AND j.requested_by = v_actor) THEN\n    RAISE EXCEPTION 'Synthetic enqueue identity mismatch.' USING ERRCODE = 'integrity_constraint_violation';\n  END IF;\n";

const occurrences = (text: string, part: string) => text.split(part).length - 1;

describe('migration 0030: the three entry points are the 0029 bodies plus exactly the declared edits', () => {
  it('is labelled breaking, and the lint rejects it as expand (control)', () => {
    expect(parseCompat('0030', up0030)).toBe('breaking');
    expect(lintMigration('0030', up0030)).toEqual([]);
    expect(lintMigration('0030', up0030.replace('-- compat: breaking', '-- compat: expand')).length).toBeGreaterThan(0);
  });

  it.each(ENTRY_POINTS)('%s: the new body equals the 0029 body with the identity lines swapped (and, for admit, the queue-row check added)', (name) => {
    const original = functionText(up0029, name, 'CREATE FUNCTION');
    const replaced = functionText(up0030, name, 'CREATE OR REPLACE FUNCTION');
    // The edit list, applied to the 0029 text. Each part must occur exactly once, or the edit would be ambiguous.
    for (const part of [DECLARE_OLD, '\nBEGIN\n', `CREATE FUNCTION public.${name}(`]) expect([name, part.slice(0, 30), occurrences(original, part)]).toEqual([name, part.slice(0, 30), 1]);
    let expected = original.replace(`CREATE FUNCTION public.${name}(`, `CREATE OR REPLACE FUNCTION public.${name}(`)
      .replace(DECLARE_OLD, DECLARE_NEW)
      .replace('\nBEGIN\n', BEGIN_NEW);
    if (name === 'agentic_synthetic_admit') {
      expect(occurrences(original, ENQUEUE_GUARD)).toBe(1);
      expected = expected.replace(ENQUEUE_GUARD, ENQUEUE_GUARD + IDENTITY_GUARD);
    }
    expect(replaced).toBe(expected);
    // And no entry point mentions a session setting for identity any more.
    expect(prosrc(replaced)).not.toMatch(/app\.current_(tenant_id|actor)/);
    expect(prosrc(replaced)).toMatch(/public\.agentic_synthetic_identity\(\)/);
  });

  it('the precondition pins the md5 of each 0029 body exactly (what pg_proc.prosrc holds), signature included', () => {
    for (const name of ENTRY_POINTS) {
      const hash = md5(prosrc(functionText(up0029, name, 'CREATE FUNCTION')));
      expect([name, up0030.includes(`ARRAY['public.${name}(${SIGNATURE[name]})', '${hash}']`)]).toEqual([name, true]);
    }
  });

  it('the down migration restores every 0029 body verbatim and drops the helper', () => {
    for (const name of ENTRY_POINTS) {
      const original = functionText(up0029, name, 'CREATE FUNCTION');
      expect(down0030.includes(original.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION'))).toBe(true);
    }
    expect(down0030).toContain('DROP FUNCTION public.agentic_synthetic_identity();');
    expect(down0030.indexOf('DROP FUNCTION public.agentic_synthetic_identity();')).toBeGreaterThan(down0030.lastIndexOf('END $$;')); // the helper goes after the bodies stop calling it
  });

  it('the helper requires a presented capability itself, in every mode (the line that makes a bare swap safe)', () => {
    const helper = functionText(up0030, 'agentic_synthetic_identity', 'CREATE FUNCTION');
    expect(helper).toContain("IF nullif(current_setting('app.capability', true), '') IS NULL THEN RETURN; END IF;");
    expect(helper).toContain('public.app_tenant()');
    expect(helper).toContain('public.app_actor()');
    expect(helper).not.toMatch(/app\.current_(tenant_id|actor)/);
    expect(up0030).toContain('REVOKE ALL ON FUNCTION public.agentic_synthetic_identity() FROM PUBLIC;');
  });
});
