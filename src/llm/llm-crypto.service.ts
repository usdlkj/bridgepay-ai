import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LEN = 12;   // 96-bit IV — recommended for GCM
const TAG_LEN = 16;  // 128-bit auth tag

@Injectable()
export class LlmCryptoService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const raw = config.get<string>('LLM_ENCRYPTION_KEY');
    if (!raw) {
      throw new Error(
        'LLM_ENCRYPTION_KEY is required. Generate with: ' +
          'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      );
    }
    // Accept 64-char hex (most common) or 44-char base64
    this.key =
      raw.length === 64
        ? Buffer.from(raw, 'hex')
        : Buffer.from(raw, 'base64');
    if (this.key.length !== 32) {
      throw new Error(
        'LLM_ENCRYPTION_KEY must decode to exactly 32 bytes ' +
          '(64 hex chars or 44 base64 chars)',
      );
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGORITHM, this.key, iv, {
      authTagLength: TAG_LEN,
    });
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    // <iv_hex>:<authTag_hex>:<ciphertext_hex>
    return [iv, authTag, encrypted].map((b) => b.toString('hex')).join(':');
  }

  decrypt(stored: string): string {
    const parts = stored.split(':');
    if (parts.length !== 3) {
      throw new Error('Malformed encrypted value — expected iv:authTag:data');
    }
    const [ivHex, authTagHex, dataHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const data = Buffer.from(dataHex, 'hex');

    const decipher = createDecipheriv(ALGORITHM, this.key, iv, {
      authTagLength: TAG_LEN,
    });
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      'utf8',
    );
  }
}
