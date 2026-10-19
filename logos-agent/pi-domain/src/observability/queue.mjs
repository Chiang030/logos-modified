/** Acknowledges local enqueue immediately; forceFlush separately waits for delivery. */
export class BoundedExporter {
  constructor(transport, config) {
    this.transport = transport; this.config = config; this.items = []; this.bytes = 0;
    this.stats = { dropped: 0, failed: 0, exported: 0, peakCount: 0, peakBytes: 0 };
    this.inFlight = 0; this.active = null; this.closed = false;
    this.timer = setInterval(() => { void this.drain(); }, 250);
    this.timer.unref();
  }
  export(spans, callback) {
    for (const span of spans) {
      const bytes = Buffer.byteLength(JSON.stringify(span.attributes)) + 2048;
      if (this.closed || this.items.length + this.inFlight >= this.config.queueSize
        || this.bytes + bytes > this.config.queueBytes) { this.stats.dropped++; continue; }
      this.items.push({ span, bytes }); this.bytes += bytes;
      this.stats.peakCount = Math.max(this.stats.peakCount, this.items.length + this.inFlight);
      this.stats.peakBytes = Math.max(this.stats.peakBytes, this.bytes);
    }
    callback({ code: 0 });
  }
  drain() {
    if (this.active) return this.active;
    this.active = this.run().catch(() => { this.stats.failed++; }).finally(() => { this.active = null; });
    return this.active;
  }
  async run() {
    while (this.items.length && !this.closed) {
      const batch = this.items.splice(0, this.config.batchSize);
      this.inFlight = batch.length;
      await new Promise((resolve) => {
        try {
          this.transport.export(batch.map(({ span }) => span), (result) => {
            if (result.code === 0) this.stats.exported += batch.length;
            else this.stats.failed += batch.length;
            resolve();
          });
        } catch { this.stats.failed += batch.length; resolve(); }
      });
      this.bytes -= batch.reduce((sum, item) => sum + item.bytes, 0); this.inFlight = 0;
    }
  }
  async forceFlush() { await deadline(this.drain(), this.config.flushMs); }
  async shutdown() {
    clearInterval(this.timer);
    await this.forceFlush(); this.closed = true;
    this.stats.dropped += this.items.length;
    this.bytes -= this.items.reduce((sum, item) => sum + item.bytes, 0); this.items.length = 0;
    await deadline(this.transport.shutdown(), this.config.flushMs);
  }
}

export async function deadline(promise, milliseconds) {
  let timer;
  try { await Promise.race([Promise.resolve(promise).catch(() => {}), new Promise((resolve) => {
    timer = setTimeout(resolve, milliseconds);
  })]); } finally { clearTimeout(timer); }
}
