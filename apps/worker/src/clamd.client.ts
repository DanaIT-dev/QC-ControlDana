import { Socket } from 'node:net';
import type { Readable } from 'node:stream';

export interface ClamScanResult {
  clean: boolean;
  signature?: string;
  engine: string;
}

export class ClamdClient {
  constructor(
    private readonly host: string,
    private readonly port: number,
  ) {}

  async ping(): Promise<void> {
    const response = await this.command('PING');
    if (!response.includes('PONG')) {
      throw new Error('ClamAV ping failed');
    }
  }

  async version(): Promise<string> {
    return (await this.command('VERSION')).trim();
  }

  async scanStream(stream: Readable): Promise<ClamScanResult> {
    const engine = await this.version().catch(() => 'clamd');
    const socket = await this.connect();
    try {
      socket.write('zINSTREAM\0');
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onEnd = () => {
          cleanup();
          resolve();
        };
        const cleanup = () => {
          stream.off('error', onError);
          stream.off('end', onEnd);
        };
        stream.on('error', onError);
        stream.on('end', onEnd);
        stream.on('data', (chunk: Buffer) => {
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length, 0);
          socket.write(size);
          socket.write(chunk);
        });
      });
      socket.write(Buffer.alloc(4));
      const raw = await readUntilEnd(socket);
      const text = raw.toString('utf8');
      if (/OK/.test(text) && !/FOUND/.test(text)) {
        return { clean: true, engine };
      }
      const match = text.match(/:\s*(.+?)\s+FOUND/);
      return { clean: false, signature: match?.[1]?.trim() ?? 'THREAT', engine };
    } finally {
      socket.destroy();
    }
  }

  private command(name: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const chunks: Buffer[] = [];
      socket.setTimeout(5000);
      socket.once('error', reject);
      socket.once('timeout', () => {
        socket.destroy();
        reject(new Error('ClamAV timeout'));
      });
      socket.on('data', (chunk) => chunks.push(chunk as Buffer));
      socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      socket.connect(this.port, this.host, () => {
        socket.write(`n${name}\n`);
      });
    });
  }

  private connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      socket.setTimeout(60_000);
      socket.once('error', reject);
      socket.once('timeout', () => {
        socket.destroy();
        reject(new Error('ClamAV timeout'));
      });
      socket.connect(this.port, this.host, () => resolve(socket));
    });
  }
}

function readUntilEnd(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk as Buffer));
    socket.once('error', reject);
    socket.once('end', () => resolve(Buffer.concat(chunks)));
  });
}
