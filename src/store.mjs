export class MemoryStore {
  constructor() { this.records = new Map(); }
  async read(owner, id) { const value = this.records.get(owner + ':' + id); return value ? structuredClone(value) : null; }
  async create(owner, board) { this.records.set(owner + ':' + board.id, { board: structuredClone(board), version: 0 }); }
  async compareAndSwap(owner, id, version, board) {
    const key = owner + ':' + id;
    if (this.records.get(key)?.version !== version) return false;
    this.records.set(key, { board: structuredClone(board), version: version + 1 });
    return true;
  }
}
export class D1Store {
  constructor(db) { this.db = db; }
  async read(owner, id) {
    const row = await this.db.prepare('SELECT data, version FROM qa_boards WHERE owner = ? AND id = ?').bind(owner, id).first();
    return row ? { board: JSON.parse(row.data), version: row.version } : null;
  }
  async create(owner, board) {
    await this.db.prepare('INSERT INTO qa_boards(owner, id, data, version) VALUES(?, ?, ?, 0)').bind(owner, board.id, JSON.stringify(board)).run();
  }
  async compareAndSwap(owner, id, version, board) {
    const result = await this.db.prepare('UPDATE qa_boards SET data = ?, version = version + 1 WHERE owner = ? AND id = ? AND version = ?').bind(JSON.stringify(board), owner, id, version).run();
    return result.meta.changes === 1;
  }
}
