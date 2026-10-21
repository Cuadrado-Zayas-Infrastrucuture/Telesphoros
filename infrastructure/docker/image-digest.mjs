// Reads the OCI archive the `image` job builds (INF-03 slice 2, specs/002-signed-image-release). Two commands:
//   digest <archive>              prints `digest=sha256:…`, the image index digest: what is scanned, released, signed and deployed (for $GITHUB_OUTPUT)
//   manifest <archive>            prints the linux/amd64 image manifest digest (what load-archive-image.sh pulls into Docker)
//   same <archive> <docker image> exits 0 only if that Docker image IS the archive's linux/amd64 image: what Trivy and the rehearsal run is what is
//                                 released. (A second `--load` build was NOT: its last layers were rebuilt with other bytes, found 2026-10-21.) It compares
//                                 CONFIG digests, read from `docker save`, so it works with either Docker image store: the config lists every layer's
//                                 content digest (rootfs.diff_ids), so the same config means the same filesystem.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const INDEX = 'application/vnd.oci.image.index.v1+json';

export function readArchive(archive, read = (path) => execFileSync('tar', ['-xOf', archive, path], { maxBuffer: 16 * 1024 * 1024 }).toString('utf8')) {
  const top = JSON.parse(read('index.json'));
  if (!Array.isArray(top.manifests) || top.manifests.length !== 1) throw new Error('the archive must hold exactly one image index');
  const [entry] = top.manifests;
  if (entry.mediaType !== INDEX || !DIGEST.test(entry.digest)) throw new Error('the archive must hold one OCI image index, by digest');
  const blob = (digest) => JSON.parse(read(`blobs/sha256/${digest.slice('sha256:'.length)}`));
  const index = blob(entry.digest);
  const images = (index.manifests ?? []).filter((m) => m.platform?.os === 'linux' && m.platform?.architecture === 'amd64');
  if (images.length !== 1) throw new Error(`the index must hold exactly one linux/amd64 image (found ${images.length})`);
  const manifest = blob(images[0].digest);
  if (!DIGEST.test(manifest.config?.digest ?? '')) throw new Error('the linux/amd64 image has no config digest');
  return { digest: entry.digest, manifest: images[0].digest, config: manifest.config.digest };
}

export function sameImage(archived, loadedConfig) {
  return DIGEST.test(loadedConfig) && loadedConfig === archived.config;
}

/** The config digest of a Docker image, from the manifest.json of `docker save` (the same in the classic and the containerd image store). */
function dockerConfig(image) {
  const saved = execFileSync('docker', ['save', image], { maxBuffer: 4 * 1024 * 1024 * 1024 });
  const list = JSON.parse(execFileSync('tar', ['-xO', 'manifest.json'], { input: saved, maxBuffer: 16 * 1024 * 1024 }).toString('utf8'));
  if (!Array.isArray(list) || list.length !== 1) throw new Error(`docker save ${image} must hold exactly one image`);
  const match = /^blobs\/sha256\/([0-9a-f]{64})$/.exec(list[0].Config ?? '') ?? /^([0-9a-f]{64})\.json$/.exec(list[0].Config ?? '');
  if (!match) throw new Error(`docker save ${image}: unexpected config path ${list[0].Config}`);
  return `sha256:${match[1]}`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, archive, image] = process.argv.slice(2);
  try {
    if (command === 'digest' && archive) {
      process.stdout.write(`digest=${readArchive(archive).digest}\n`);
    } else if (command === 'manifest' && archive) {
      process.stdout.write(`${readArchive(archive).manifest}\n`);
    } else if (command === 'same' && archive && image) {
      const archived = readArchive(archive);
      const loaded = dockerConfig(image);
      if (!sameImage(archived, loaded)) throw new Error(`the scanned image (config ${loaded}) is not the archive's linux/amd64 image (config ${archived.config})`);
      process.stdout.write(`the scanned image is the archive's linux/amd64 image (config ${loaded})\n`);
    } else {
      throw new Error('usage: image-digest.mjs digest <archive> | manifest <archive> | same <archive> <docker image>');
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
