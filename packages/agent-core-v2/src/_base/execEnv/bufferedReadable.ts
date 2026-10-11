import { Readable } from 'node:stream';

const RESUME_LIVENESS_MS = 10;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

export class BufferedReadable extends Readable {
  private readonly _source: Readable;
  private _ended: boolean = false;
  private _consumerArrived: boolean = false;
  private _resumeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(source: Readable) {
    super({ highWaterMark: 128 * 1024 });
    this._source = source;
    this._source.on('data', this._onData);
    this._source.on('end', this._onEnd);
    this._source.on('close', this._onClose);
    this._source.on('error', this._onError);
  }

  override _read(): void {
    this._consumerArrived = true;
    this._clearResume();
    if (!this._ended && !this.destroyed) {
      this._source.resume();
    }
  }

  private _hasReadableConsumer(): boolean {
    return (
      this.listenerCount('readable') + this.listenerCount('data') > 0 ||
      this.readableFlowing !== null
    );
  }

  private _armResume(): void {
    if (this._resumeTimer !== undefined) return;
    this._resumeTimer = setTimeout(() => {
      this._resumeTimer = undefined;
      if (this.readableLength >= MAX_BUFFERED_BYTES) return;
      if (!this._ended && !this.destroyed) {
        this._source.resume();
      }
    }, RESUME_LIVENESS_MS);
    this._resumeTimer.unref?.();
  }

  private _clearResume(): void {
    if (this._resumeTimer !== undefined) {
      clearTimeout(this._resumeTimer);
      this._resumeTimer = undefined;
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this._clearResume();
    this._source.off('data', this._onData);
    this._source.off('end', this._onEnd);
    this._source.off('close', this._onClose);
    this._source.off('error', this._onError);
    this._source.destroy();
    callback(error);
  }

  private readonly _onData = (chunk: string | Uint8Array): void => {
    if (!this.push(chunk)) {
      this._source.pause();
      if (!this._consumerArrived && !this._hasReadableConsumer()) {
        this._armResume();
      }
    }
  };

  private readonly _onEnd = (): void => {
    this._clearResume();
    this._ended = true;
    this.push(null);
  };

  private readonly _onClose = (): void => {
    this._clearResume();
    if (!this._ended) {
      this._ended = true;
      this.push(null);
    }
  };

  private readonly _onError = (error: Error): void => {
    this.destroy(error);
  };
}
