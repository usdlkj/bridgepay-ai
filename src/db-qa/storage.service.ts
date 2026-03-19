import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'fs/promises';
import { resolve } from 'path';

interface IStorageBackend {
  readFile(pathOrKey: string): Promise<string>;
}

class LocalStorageBackend implements IStorageBackend {
  async readFile(filePath: string): Promise<string> {
    const resolved = filePath.startsWith('/') ? filePath : resolve(process.cwd(), filePath);
    return readFile(resolved, 'utf-8');
  }
}

/**
 * S3 backend using dynamic imports so @aws-sdk/client-s3 is optional at build
 * time. Only instantiated when STORAGE_BACKEND=s3 is configured.
 */
class S3StorageBackend implements IStorageBackend {
  private readonly bucket: string;
  private readonly region: string;
  private readonly accessKeyId?: string;
  private readonly secretAccessKey?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private s3Client: any = null;

  constructor(config: ConfigService) {
    this.bucket = config.getOrThrow<string>('S3_BUCKET');
    this.region = config.get<string>('S3_REGION') ?? 'ap-southeast-3';
    this.accessKeyId = config.get<string>('S3_ACCESS_KEY_ID');
    this.secretAccessKey = config.get<string>('S3_SECRET_ACCESS_KEY');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async getClient(): Promise<any> {
    if (this.s3Client) return this.s3Client;
    try {
      // Use require() to avoid TypeScript module-resolution errors when the
      // package is not yet installed. S3 backend is only instantiated when
      // STORAGE_BACKEND=s3 is explicitly set.
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
      const sdk = require('@aws-sdk/client-s3') as any;
      const credentials =
        this.accessKeyId && this.secretAccessKey
          ? { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey }
          : undefined;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      this.s3Client = new sdk.S3Client({ region: this.region, credentials });
      return this.s3Client;
    } catch {
      throw new Error(
        '@aws-sdk/client-s3 is not installed. Run: pnpm add @aws-sdk/client-s3',
      );
    }
  }

  async readFile(key: string): Promise<string> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const client = await this.getClient();
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
    const { GetObjectCommand } = require('@aws-sdk/client-s3') as any;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
    const cmd = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    const response = await client.send(cmd);
    // AWS SDK v3 Body exposes transformToString()
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    return (await response.Body.transformToString('utf-8')) as string;
  }
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly backend: IStorageBackend;

  constructor(config: ConfigService) {
    const backendType = config.get<string>('STORAGE_BACKEND') ?? 'local';
    if (backendType === 's3') {
      this.backend = new S3StorageBackend(config);
      this.logger.log('Storage backend: S3');
    } else {
      this.backend = new LocalStorageBackend();
      this.logger.log('Storage backend: local');
    }
  }

  async readFile(pathOrKey: string): Promise<string> {
    return this.backend.readFile(pathOrKey);
  }
}
