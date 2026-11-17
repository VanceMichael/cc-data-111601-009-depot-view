import { mkdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const DELIVERY_INDEX = 'deliveries.json';

export class Store {
  constructor(directory) {
    this.directory = directory;
    this.pending = Promise.resolve();
    this.deliveryPending = Promise.resolve();
  }
  async initialize() {
    await mkdir(join(this.directory, 'objects'), { recursive: true });
    await mkdir(join(this.directory, 'delivery-objects'), { recursive: true });
    try { await this.list(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveIndex([]);
    }
    try { await this.listDeliveries(); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.saveDeliveries([]);
    }
    return this;
  }
  async saveIndex(records) {
    const temporary = join(this.directory, `index-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(records));
    await rename(temporary, join(this.directory, 'index.json'));
  }
  async list() {
    return JSON.parse(await readFile(join(this.directory, 'index.json'), 'utf8'));
  }
  async accept(bytes, source, parsed) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const operation = this.pending.then(async () => {
      const records = await this.list();
      const existing = records.find(record => record.digest === digest && record.source === source);
      if (existing) return existing;
      await writeFile(join(this.directory, 'objects', digest), bytes);
      const record = { id: randomUUID(), digest, source, bytes: bytes.length, parsed };
      records.push(record);
      await this.saveIndex(records);
      return record;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async object(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_digest');
    return readFile(join(this.directory, 'objects', digest));
  }
  async saveDeliveries(deliveries) {
    const temporary = join(this.directory, `deliveries-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(deliveries, null, 2));
    await rename(temporary, join(this.directory, DELIVERY_INDEX));
  }
  async listDeliveries() {
    return JSON.parse(await readFile(join(this.directory, DELIVERY_INDEX), 'utf8'));
  }
  async getDelivery(id) {
    const deliveries = await this.listDeliveries();
    const delivery = deliveries.find(item => item.id === id);
    if (!delivery) {
      const error = new Error('delivery_not_found');
      error.code = 'ENOENT';
      throw error;
    }
    return delivery;
  }
  // 交付记录整体替换，串行化避免并发领取互相覆盖；碰撞态也会被持久化以便核对。
  async saveDelivery(next) {
    const operation = this.deliveryPending.then(async () => {
      const deliveries = await this.listDeliveries();
      const position = deliveries.findIndex(item => item.id === next.id);
      if (position < 0) deliveries.push(next);
      else deliveries[position] = next;
      await this.saveDeliveries(deliveries);
      return next;
    });
    this.deliveryPending = operation.catch(() => {});
    return operation;
  }
  // 内容寻址保存交付字节；同摘要天然去重，绝不按交付路径覆盖。
  async saveContent(bytes) {
    const digest = createHash('sha256').update(bytes).digest('hex');
    const target = join(this.directory, 'delivery-objects', digest);
    try { await access(target); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const temporary = join(this.directory, `content-${randomUUID()}.tmp`);
      await writeFile(temporary, bytes);
      await rename(temporary, target);
    }
    return digest;
  }
  async deliveryObject(digest) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid_digest');
    return readFile(join(this.directory, 'delivery-objects', digest));
  }
}
