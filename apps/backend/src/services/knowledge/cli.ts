import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { knowledgeFileSchema } from '@telesphoros/cpic-schema';
import { contentSha256 } from './content-hash';
import { KnowledgeLoadError, loadKnowledge } from './knowledge-loader';
import { KNOWLEDGE_SET_ID, locateKnowledgeSet } from './knowledge-locate';

const USAGE = `Usage: node dist/services/knowledge/cli.js <command>

  verify [--dir DIR] [--production]   load the knowledge directory and report every problem
                                       (default DIR: KNOWLEDGE_DIR, else ../../knowledge/cpic)
  hash FILE                           print the content hash a reviewer signs for one knowledge file
                                       (put it in review.contentSha256 after reviewing the file);
                                       refuses real content whose license or redistribution is "unknown"
  locate ID [--repo PATH] [--dir REL] [--production] [--all-refs] [--limit N]
                                       find the git commits whose knowledge directory loads to the knowledge
                                       set ID an evaluation stored (default REL: knowledge/cpic, N: 500);
                                       exits 1 when no examined commit matches
`;

const LOCATE_LIMIT = 500;

/** Runs a command and returns the process exit code. Output goes through \`write\` so tests can read it. */
export async function runKnowledgeCli(args: readonly string[], write: (line: string) => void, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [command, ...rest] = args;
  try {
    if (command === 'verify') {
      const dirFlag = rest.indexOf('--dir');
      const directory = resolve(dirFlag >= 0 ? (rest[dirFlag + 1] ?? '') : (env.KNOWLEDGE_DIR ?? '../../knowledge/cpic'));
      const mode = rest.includes('--production') ? 'production' : 'non-production';
      const set = await loadKnowledge({ directory, mode });
      write(`OK (${mode}): ${set.files.length} files, ${set.guidelineCount} guidelines, knowledge set ${set.id}`);
      if (set.isEmpty) write('Note: no guidelines are loaded, so every drug will report NO_MATCHING_GUIDELINE.');
      return 0;
    }
    if (command === 'hash' && rest[0] !== undefined) {
      const parsed = knowledgeFileSchema.safeParse(JSON.parse(await readFile(rest[0], 'utf8')));
      if (!parsed.success) {
        write('The file is not a valid knowledge file. Run "verify" to see why.');
        return 1;
      }
      const { synthetic, provenance } = parsed.data;
      if (!synthetic && (provenance.license === 'unknown' || provenance.redistribution === 'unknown')) {
        // A signature binds a reviewer to the content, and real content must say what its license allows first.
        write('Not ready to sign: provenance.license and provenance.redistribution must both be stated (not "unknown") for real content.');
        return 1;
      }
      write(contentSha256(parsed.data));
      return 0;
    }
    if (command === 'locate' && rest[0] !== undefined) {
      const id = rest[0];
      const flag = (name: string) => (rest.indexOf(name) >= 0 ? rest[rest.indexOf(name) + 1] : undefined);
      const limit = Number(flag('--limit') ?? LOCATE_LIMIT);
      if (!KNOWLEDGE_SET_ID.test(id) || !Number.isInteger(limit) || limit < 1 || limit > 10000) {
        write('A knowledge set id is 64 lowercase hex characters, and --limit is a whole number from 1 to 10000.');
        return 2;
      }
      const directory = flag('--dir') ?? 'knowledge/cpic';
      let result;
      try {
        result = await locateKnowledgeSet({ repo: resolve(flag('--repo') ?? '.'), directory, id, mode: rest.includes('--production') ? 'production' : 'non-production', limit, allRefs: rest.includes('--all-refs') });
      } catch {
        // intentional: git's own error text can quote paths and refs; the operator needs the one thing to check
        write('The search could not run (is --repo inside a git working tree, is --dir a relative path, and is git installed?).');
        return 1;
      }
      for (const match of result.matches) write(`FOUND ${match.commit} ${match.date} ${match.subject}`);
      if (result.truncated) write(`Note: only the newest ${result.examined} commits that changed ${directory} were examined; raise --limit to look further back.`);
      if (result.matches.length > 0) return 0;
      write(`NOT FOUND: none of the ${result.examined} commits examined has knowledge set ${id} (${result.unloadable} did not load as a set).`);
      return 1;
    }
    write(USAGE);
    return 2;
  } catch (error) {
    if (error instanceof KnowledgeLoadError) {
      write(error.message);
      return 1;
    }
    write('The command could not run (is the path right?).');
    return 1;
  }
}

if (require.main === module) {
  runKnowledgeCli(process.argv.slice(2), (line) => process.stdout.write(`${line}\n`)).then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
