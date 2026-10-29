/** Private object storage boundary for uploaded receipt images. */
export interface ReceiptStorage {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}
