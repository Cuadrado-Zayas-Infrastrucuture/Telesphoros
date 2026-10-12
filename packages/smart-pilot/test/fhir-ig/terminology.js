// Closed terminology surface of this synthetic exporter, not a general terminology service.
const ns = 'https://telesphoros.app/synthetic-smart-pilot';
const terms = new Map([
  ['http://loinc.org', new Set(['84413-4', '51969-4'])],
  ['http://terminology.hl7.org/CodeSystem/observation-category', new Set(['laboratory'])],
  ['http://terminology.hl7.org/CodeSystem/v2-0074', new Set(['GE'])],
  ['http://terminology.hl7.org/CodeSystem/v3-DataOperation', new Set(['CREATE'])],
  [`${ns}/codes`, new Set(['pgx-phenotype'])],
  [ns, new Set(['synthetic-not-for-clinical-use'])],
]);
export function terminologyIssues(bundle) {
  const issues = [];
  const coding = (item, path) => {
    if (!terms.get(item?.system)?.has(item?.code)) issues.push(path);
  };
  const walk = (value, path) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['coding', 'tag', 'security'].includes(key)) {
        if (!Array.isArray(child)) issues.push(`${path}.${key}`);
        else child.forEach((c, i) => coding(c, `${path}.${key}[${i}]`));
      } else walk(child, `${path}.${key}`);
    }
  };
  walk(bundle, 'Bundle');
  return issues;
}
