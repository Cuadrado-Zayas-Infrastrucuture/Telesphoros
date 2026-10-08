import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { knowledgeFileSchema } from '@telesphoros/cpic-schema';
import { contentSha256 } from './content-hash';
import { KnowledgeLoadError, loadKnowledge } from './knowledge-loader';

const USAGE = `Usage: node dist/services/knowledge/cli.js <command>

  verify [--dir DIR] [--production]   load the knowledge directory and report every problem
                                       (default DIR: KNOWLEDGE_DIR, else ../../knowledge/cpic)
  hash FILE                           print the content hash a reviewer signs for one knowledge file
                                       (put it in review.contentSha256 after reviewing the file)
`;

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
      write(contentSha256(parsed.data));
      return 0;
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
