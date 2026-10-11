import crypto from "node:crypto";
import axios from "axios";
import { fileLinkDtoSchema, MAX_REPORT_BYTES } from "@telesphoros/shared-types";
import { fail, loopbackUrl } from "./client.js";

/** The authorized API supplies the signed URL. Never accept a browser-supplied URL or forward either bearer. */
export async function readSourcePdf(value: unknown, origin: string,
  expected: { sizeBytes: number; sha256: string }, now = Date.now) {
  const link = fileLinkDtoSchema.parse(value);
  const url = loopbackUrl(link.url);
  const versions = url.searchParams.getAll("versionId");
  const expires = Date.parse(link.expiresAt);
  if (url.origin !== origin || versions.length !== 1 || !versions[0] || versions[0] === "null" ||
      versions[0].length > 1024 || expires <= now() ||
      !Number.isInteger(expected.sizeBytes) || expected.sizeBytes < 5 || expected.sizeBytes > MAX_REPORT_BYTES ||
      !/^[a-f0-9]{64}$/.test(expected.sha256)) fail("invalid_source_link");
  const response = await axios({
    url: url.href, method: "GET", responseType: "arraybuffer",
    headers: { Accept: "application/pdf" }, timeout: 5000, signal: AbortSignal.timeout(5000), maxRedirects: 0,
    maxContentLength: expected.sizeBytes, proxy: false, decompress: false,
    validateStatus: status => status === 200,
  });
  const bytes = Buffer.from(response.data);
  if (response.headers["x-amz-version-id"] !== versions[0] ||
      response.headers["content-type"] !== "application/pdf" ||
      (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") ||
      bytes.length !== expected.sizeBytes || bytes.subarray(0, 5).toString("ascii") !== "%PDF-" ||
      crypto.createHash("sha256").update(bytes).digest("hex") !== expected.sha256 || expires <= now())
    fail("source_pdf_withheld");
  return { versionId: versions[0], sha256: expected.sha256, data: bytes.toString("base64"), size: bytes.length, expires };
}
