// Local fixtures read the same contract Terraform uses. Only the explicit loopback origin differs.
const fs = require('node:fs');
const path = require('node:path');
const contract = JSON.parse(fs.readFileSync(path.join(__dirname, '../../infrastructure/terraform/reports-cors.json'), 'utf8'));
function reportsCorsRule(origin) {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== origin || !url.port) throw new Error('Expected exact synthetic loopback origin');
  return { AllowedOrigins: [origin], AllowedMethods: [...contract.allowed_methods], AllowedHeaders: [...contract.allowed_headers], ExposeHeaders: [...contract.expose_headers], MaxAgeSeconds: contract.max_age_seconds };
}
const escapeXml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
function reportsCorsXml(origin) {
  const rule = reportsCorsRule(origin);
  const tags = [['AllowedOrigin', rule.AllowedOrigins], ['AllowedMethod', rule.AllowedMethods], ['AllowedHeader', rule.AllowedHeaders], ['ExposeHeader', rule.ExposeHeaders], ['MaxAgeSeconds', [rule.MaxAgeSeconds]]];
  return '<CORSConfiguration><CORSRule>' + tags.flatMap(([tag, values]) => values.map(value => `<${tag}>${escapeXml(value)}</${tag}>`)).join('') + '</CORSRule></CORSConfiguration>';
}
module.exports = { reportsCorsRule, reportsCorsXml };
