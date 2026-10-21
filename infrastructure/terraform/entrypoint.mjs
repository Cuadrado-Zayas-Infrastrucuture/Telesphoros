// The reading of the image ENTRYPOINT and of the ECS task commands that run the API image, shared by the guard (entrypoint.guard.test.mjs) and by the image rehearsal
// (infrastructure/docker/command-smoke.cjs), so both judge the same Terraform text the same way. No tests here: importing this file registers nothing.

export const code = (text) => text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

/** The image's ENTRYPOINT as a list, or null when the Dockerfile does not give one in exec form (then this guard cannot judge a command and says so). */
export function imageEntrypoint(docker) {
  const found = [...code(docker).matchAll(/^ENTRYPOINT\s+(\[.*\])\s*$/gm)];
  if (found.length === 0) return null;
  try {
    const list = JSON.parse(found[found.length - 1][1]);
    return Array.isArray(list) && list.every((x) => typeof x === 'string') ? list : null;
  } catch {
    return null;
  }
}

/**
 * Every `{ ... }` object of the text that runs a pinned API image, with its OWN top-level lines (nested objects, such as healthCheck, removed). A container
 * definition is one of these; a nested `command` belongs to a child object and is never read as the container's.
 */
export function apiImageContainers(text) {
  const found = [];
  const open = [];
  const body = code(text);
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') open.push({ start: i, children: [] });
    else if (body[i] === '}' && open.length > 0) {
      const node = open.pop();
      if (open.length > 0) open[open.length - 1].children.push([node.start, i + 1]);
      let own = '';
      let at = node.start + 1;
      for (const [from, to] of node.children) {
        own += body.slice(at, from);
        at = to;
      }
      own += body.slice(at, i);
      if (/^\s*image\s*=.*\bvar\.(?:api_image|api_migrate_image)\b/m.test(own)) found.push(own);
    }
  }
  return found;
}

/** A container's whole top-level `command = [...]` as a list of strings, or undefined when it has none or it holds anything but plain strings. */
export function commandList(container) {
  const match = /^\s*command\s*=\s*\[([^\]]*)\]/m.exec(container);
  if (!match) return undefined;
  const items = [...match[1].matchAll(/\s*"([^"$]*)"\s*(?:,|$)/g)].map((m) => m[1]);
  return items.length > 0 && match[1].replace(/\s*"[^"$]*"\s*,?/g, '').trim() === '' ? items : undefined;
}

/** The first element of a container's top-level `command = [...]`, or undefined when it has none. */
export function commandHead(container) {
  const match = /^\s*command\s*=\s*\[\s*"([^"]*)"/m.exec(container);
  return match ? match[1] : undefined;
}
