import { connect } from 'node:net';

export interface ScanResult { clean: boolean; signature?: string }
export interface AntivirusPort { scan(data: Buffer): Promise<ScanResult> }

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** Dev/test scanner: only flags the industry-standard EICAR test string. Refused in production config. */
export class NoopScanner implements AntivirusPort {
  async scan(data: Buffer): Promise<ScanResult> {
    return data.includes(EICAR) ? { clean: false, signature: 'Eicar-Test-Signature' } : { clean: true };
  }
}

/** clamd INSTREAM protocol over TCP. */
export class ClamAvScanner implements AntivirusPort {
  constructor(private readonly host: string, private readonly port: number, private readonly timeoutMs = 30_000) {}

  scan(data: Buffer): Promise<ScanResult> {
    return new Promise((resolve, reject) => {
      const sock = connect({ host: this.host, port: this.port });
      let out = '';
      sock.setTimeout(this.timeoutMs, () => { sock.destroy(); reject(new Error('clamd timeout')); });
      sock.on('error', reject);
      sock.on('data', (d) => (out += d.toString()));
      sock.on('close', () => {
        const line = out.replace(/\0/g, '').trim();
        if (line.endsWith('OK')) return resolve({ clean: true });
        const m = /stream: (.+) FOUND/.exec(line);
        if (m) return resolve({ clean: false, signature: m[1] });
        reject(new Error(`Unexpected clamd response: ${line.slice(0, 200)}`));
      });
      sock.on('connect', () => {
        sock.write('zINSTREAM\0');
        const CHUNK = 64 * 1024;
        for (let i = 0; i < data.length; i += CHUNK) {
          const part = data.subarray(i, i + CHUNK);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length);
          sock.write(len); sock.write(part);
        }
        sock.write(Buffer.alloc(4)); // zero-length chunk terminates the stream
      });
    });
  }
}
