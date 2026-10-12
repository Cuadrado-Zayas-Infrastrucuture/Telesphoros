import type { ReportType } from '@telesphoros/shared-types';
export class InvalidStructureError extends Error {
    constructor() { super('The file does not match the declared structural format.'); this.name = 'InvalidStructureError'; }
}
const bad = (): never => { throw new InvalidStructureError(); };
const whitespace = (c: string) => c === ' ' || c === '\t' || c === '\r' || c === '\n';
type Frame = {
    kind: 'object' | 'array';
    expect: 'key-or-end' | 'key' | 'colon' | 'value-or-end' | 'value' | 'comma-or-end';
};
/** Syntax only: bounded tokens/depth; never builds or retains a JSON object tree. */
class JsonSyntax {
    private readonly stack: Frame[] = [];
    private done = false;
    private token: 'string' | 'number' | 'literal' | undefined;
    private value = '';
    private stringSize = 0;
    private key = false;
    private escaped = false;
    private unicode = 0;
    private literal = '';
    feed(text: string) { for (const c of text)
        this.char(c); }
    private consumed() {
        const frame = this.stack.at(-1);
        if (frame) {
            if (!['value', 'value-or-end'].includes(frame.expect))
                bad();
            frame.expect = 'comma-or-end';
        }
        else {
            if (this.done)
                bad();
            this.done = true;
        }
    }
    private close(c: string) {
        const frame = this.stack.at(-1);
        if (!frame || (c === '}' ? frame.kind !== 'object' : frame.kind !== 'array'))
            bad();
        this.stack.pop();
    }
    private finishScalar() {
        if (this.token === 'number') {
            if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(this.value) || !Number.isFinite(Number(this.value)))
                bad();
        }
        else if (this.token === 'literal' && this.value !== this.literal)
            bad();
        this.token = undefined;
        this.value = '';
    }
    private char(c: string): void {
        if (this.token === 'string') {
            if (++this.stringSize > 65536)
                bad();
            if (this.unicode) {
                if (!/^[0-9a-fA-F]$/.test(c))
                    bad();
                this.unicode--;
                return;
            }
            if (this.escaped) {
                this.escaped = false;
                if (c === 'u')
                    this.unicode = 4;
                else if (!'"\\/bfnrt'.includes(c))
                    bad();
                return;
            }
            if (c === '\\') {
                this.escaped = true;
                return;
            }
            if (c === '"') {
                this.token = undefined;
                if (this.key)
                    this.stack.at(-1)!.expect = 'colon';
                return;
            }
            if (c.charCodeAt(0) < 32)
                bad();
            return;
        }
        if (this.token) {
            if (this.token === 'number' && /^[0-9eE.+-]$/.test(c)) {
                if (this.value.length >= 128)
                    bad();
                this.value += c;
                return;
            }
            if (this.token === 'literal' && /^[a-z]$/.test(c)) {
                if (this.value.length >= 5)
                    bad();
                this.value += c;
                return;
            }
            this.finishScalar();
            this.char(c);
            return;
        }
        if (whitespace(c))
            return;
        const frame = this.stack.at(-1);
        if (frame?.expect === 'colon') {
            if (c !== ':')
                bad();
            frame.expect = 'value';
            return;
        }
        if (frame?.expect === 'comma-or-end') {
            if (c === '}' || c === ']') {
                this.close(c);
                return;
            }
            if (c !== ',')
                bad();
            frame.expect = frame.kind === 'object' ? 'key' : 'value';
            return;
        }
        if (frame?.expect === 'key' || frame?.expect === 'key-or-end') {
            if (c === '}' && frame.expect === 'key-or-end') {
                this.close(c);
                return;
            }
            if (c !== '"')
                bad();
            this.key = true;
            this.token = 'string';
            this.stringSize = 0;
            return;
        }
        if (c === ']' && frame?.expect === 'value-or-end') {
            this.close(c);
            return;
        }
        this.consumed();
        if (c === '{' || c === '[') {
            if (this.stack.length >= 64)
                bad();
            this.stack.push({ kind: c === '{' ? 'object' : 'array', expect: c === '{' ? 'key-or-end' : 'value-or-end' });
            return;
        }
        if (c === '"') {
            this.key = false;
            this.token = 'string';
            this.stringSize = 0;
            return;
        }
        if (c === '-' || /^[0-9]$/.test(c)) {
            this.token = 'number';
            this.value = c;
            return;
        }
        if ('tfn'.includes(c)) {
            this.token = 'literal';
            this.literal = c === 't' ? 'true' : c === 'f' ? 'false' : 'null';
            this.value = c;
            return;
        }
        bad();
    }
    finish() { if (this.token === 'string')
        bad(); if (this.token)
        this.finishScalar(); if (!this.done || this.stack.length)
        bad(); }
}
export class StructuralValidator {
    private prefix = Buffer.alloc(0);
    private tail = Buffer.alloc(0);
    private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    private readonly json = new JsonSyntax();
    private line = '';
    private lineBytes = 0;
    private headerBytes = 0;
    private first = true;
    private columns = false;
    constructor(private readonly type: ReportType) { }
    feed(bytes: Buffer) {
        if (this.type === 'lab-pdf') {
            if (this.prefix.length < 9)
                this.prefix = Buffer.concat([this.prefix, bytes.subarray(0, 9 - this.prefix.length)]);
            this.tail = bytes.length >= 1024 ? Buffer.from(bytes.subarray(-1024)) : Buffer.concat([this.tail, bytes]).subarray(-1024);
            return;
        }
        let text: string;
        try {
            text = this.decoder.decode(bytes, { stream: true });
        }
        catch {
            return bad();
        }
        this.text(text);
    }
    private text(text: string) {
        if (this.type === 'structured') {
            this.json.feed(text);
            return;
        }
        if (text.includes('\0'))
            bad();
        if (this.columns)
            return; // Opaque variant rows; UTF-8 remains checked on every chunk.
        for (const c of text) {
            const length = Buffer.byteLength(c, 'utf8');
            this.headerBytes += length;
            this.lineBytes += length;
            if (this.headerBytes > 262144 || this.lineBytes > 65536)
                bad();
            if (c !== '\n') {
                this.line += c;
                continue;
            }
            const line = this.line.replace(/\r$/, '');
            this.line = '';
            this.lineBytes = 0;
            if (this.first) {
                if (!/^##fileformat=VCFv4\.[1-5]$/.test(line))
                    bad();
                this.first = false;
            }
            else if (line.startsWith('##'))
                continue;
            else {
                const cols = line.split('\t');
                if (cols.slice(0, 8).join('\t') !== '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO' || cols.length < 8 ||
                    (cols.length > 8 && (cols[8] !== 'FORMAT' || cols.length < 10 || cols.slice(9).some(c => !c))))
                    bad();
                this.columns = true;
                break;
            }
        }
    }
    finish() {
        if (this.type === 'lab-pdf') {
            if (!/^%PDF-(1\.[0-7]|2\.0)(\r|\n)/.test(this.prefix.toString('latin1')) || !/%%EOF[\t\r\n ]*$/.test(this.tail.toString('latin1')))
                bad();
            return;
        }
        try {
            this.text(this.decoder.decode());
        }
        catch {
            return bad();
        }
        if (this.type === 'structured')
            this.json.finish();
        else if (!this.columns)
            bad();
    }
}
