import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('llm_api_keys')
export class LlmApiKey {
  @PrimaryGeneratedColumn()
  id: number;

  /**
   * Matches adapter providerCode: 'anthropic' | 'openai' | 'qwen' | 'ollama'
   */
  @Column({ name: 'provider_code', type: 'varchar', length: 50, unique: true })
  providerCode: string;

  /**
   * AES-256-GCM encrypted API key.
   * Format: <iv_hex>:<authTag_hex>:<ciphertext_hex>
   * Null for providers that don't require an API key (e.g. local Ollama).
   */
  @Column({ name: 'api_key', type: 'text', nullable: true })
  apiKey: string | null;

  /**
   * Optional base URL override — used by Qwen (DashScope) and Ollama.
   */
  @Column({ name: 'base_url', type: 'varchar', length: 500, nullable: true })
  baseUrl: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
