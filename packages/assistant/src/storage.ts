import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/**
 * Almacenamiento PRIVADO de adjuntos. Interfaz mínima para poder sustituirlo
 * por un almacén de objetos en producción (dependencia externa X-04). La
 * implementación local guarda en un directorio fuera de todo `public/`, con
 * permisos 0600, bajo una clave opaca generada por el servidor. Nunca se
 * sirve directamente: la API lo entrega tras autorizar al titular.
 */
export interface BlobStorage {
  put(data: Buffer): Promise<string>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

const KEY_RE = /^[0-9a-f]{2}\/[0-9a-f-]{36}$/;

export class LocalPrivateStorage implements BlobStorage {
  private readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string): string {
    if (!KEY_RE.test(key)) throw new Error('invalid storage key');
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + '/')) throw new Error('invalid storage key');
    return p;
  }

  async put(data: Buffer): Promise<string> {
    const id = randomUUID();
    const key = `${id.slice(0, 2)}/${id}`;
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true, mode: 0o700 });
    await writeFile(p, data, { mode: 0o600, flag: 'wx' });
    return key;
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }

  async remove(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

/** Para pruebas: en memoria. */
export class MemoryStorage implements BlobStorage {
  readonly blobs = new Map<string, Buffer>();
  async put(data: Buffer): Promise<string> {
    const id = randomUUID();
    const key = `${id.slice(0, 2)}/${id}`;
    this.blobs.set(key, Buffer.from(data));
    return key;
  }
  async get(key: string): Promise<Buffer> {
    const b = this.blobs.get(key);
    if (!b) throw new Error('not found');
    return b;
  }
  async remove(key: string): Promise<void> {
    this.blobs.delete(key);
  }
}
