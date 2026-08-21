import type { TenantId } from "../../core/tenant.ts";
import type { R2BucketBinding, R2ObjectBinding } from "../cloudflare/cloudflare-bindings.ts";
import type { ITransitFileService, TransitFileRead, TransitFileUpload } from "./transit-file-store.ts";

import { extname } from "node:path";
import { compatibilityTenantId } from "../../core/tenant.ts";
import { contentDispositionForFileName, contentTypeFromFileId, TransitFileError } from "./transit-file-store.ts";

export interface R2TransitFileOptions {
  bucket: R2BucketBinding;
  publicOrigin: string;
  ttlSeconds: number;
  maxBytes: number;
}

interface TransitFileMetadata {
  tenantId: TenantId;
  name: string;
  mimeType: string;
  createdAt: string;
  sizeBytes: number;
}

export class R2TransitFileService implements ITransitFileService {
  private readonly bucket: R2BucketBinding;
  private readonly publicOrigin: string;
  private readonly ttlMs: number;
  readonly maxBytes: number;

  constructor(options: R2TransitFileOptions) {
    this.bucket = options.bucket;
    this.publicOrigin = options.publicOrigin.replace(/\/+$/, "");
    this.ttlMs = options.ttlSeconds * 1000;
    this.maxBytes = options.maxBytes;
  }

  async create(file: File, tenantId: TenantId = compatibilityTenantId): Promise<TransitFileUpload> {
    this.assertFileSize(file.size);
    const fileId = `${randomHex(16)}${safeExtension(file.name)}`;
    const metadata = normalizeMetadata({
      tenantId,
      name: file.name || fileId,
      mimeType: file.type || contentTypeFromFileId(fileId),
      createdAt: new Date().toISOString(),
      sizeBytes: file.size,
    });

    await this.bucket.put(objectKey(tenantId, fileId), file.stream(), {
      httpMetadata: { contentType: metadata.mimeType },
    });
    await this.bucket.put(metadataKey(tenantId, fileId), JSON.stringify(metadata));

    return {
      fileId,
      downloadUrl: `${this.publicOrigin}/api/files/${encodeURIComponent(fileId)}`,
      sizeBytes: metadata.sizeBytes,
      name: metadata.name,
      mimeType: metadata.mimeType,
    };
  }

  async read(fileId: string, tenantId: TenantId = compatibilityTenantId): Promise<TransitFileRead> {
    const { object, metadata } = await this.readObject(tenantId, fileId);
    return {
      file: new File([await object.arrayBuffer()], metadata.name, { type: metadata.mimeType }),
      sizeBytes: metadata.sizeBytes,
      name: metadata.name,
      mimeType: metadata.mimeType,
    };
  }

  async response(fileId: string, tenantId: TenantId = compatibilityTenantId): Promise<Response> {
    const { object, metadata } = await this.readObject(tenantId, fileId);
    return new Response(object.body, {
      headers: {
        "content-length": String(metadata.sizeBytes),
        "content-type": metadata.mimeType,
        "content-disposition": contentDispositionForFileName(metadata.name),
      },
    });
  }

  async delete(fileId: string, tenantId: TenantId = compatibilityTenantId): Promise<boolean> {
    assertSafeFileId(fileId);
    const existing = await this.bucket.get(objectKey(tenantId, fileId));
    await Promise.all([
      this.bucket.delete(objectKey(tenantId, fileId)),
      this.bucket.delete(metadataKey(tenantId, fileId)),
    ]);
    return existing != null;
  }

  async cleanupExpired(): Promise<void> {}

  private async readObject(
    tenantId: TenantId,
    fileId: string,
  ): Promise<{
    object: R2ObjectBinding;
    metadata: TransitFileMetadata;
  }> {
    assertSafeFileId(fileId);
    const [object, metadata] = await Promise.all([
      this.bucket.get(objectKey(tenantId, fileId)),
      this.readMetadata(tenantId, fileId),
    ]);
    if (!object || !metadata || this.isExpired(metadata)) {
      await this.delete(fileId, tenantId);
      throw new TransitFileError(404, "file_not_found", "Transit file was not found.");
    }

    return { object, metadata };
  }

  private async readMetadata(tenantId: TenantId, fileId: string): Promise<TransitFileMetadata | undefined> {
    const metadata = await this.bucket.get(metadataKey(tenantId, fileId));
    if (!metadata) {
      return undefined;
    }

    try {
      return normalizeMetadata(JSON.parse(await metadataText(metadata)) as Partial<TransitFileMetadata>);
    } catch {
      return undefined;
    }
  }

  private assertFileSize(size: number): void {
    if (size > this.maxBytes) {
      throw new TransitFileError(413, "file_too_large", `Transit file must be ${this.maxBytes} bytes or smaller.`);
    }
  }

  private isExpired(metadata: TransitFileMetadata): boolean {
    return Date.now() - Date.parse(metadata.createdAt) > this.ttlMs;
  }
}

async function metadataText(metadata: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<string> {
  return new TextDecoder().decode(await metadata.arrayBuffer());
}

function normalizeMetadata(input: Partial<TransitFileMetadata>): TransitFileMetadata {
  return {
    tenantId: typeof input.tenantId === "string" ? (input.tenantId as TenantId) : ("" as TenantId),
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : "file",
    mimeType:
      typeof input.mimeType === "string" && input.mimeType.trim() ? input.mimeType.trim() : "application/octet-stream",
    createdAt: typeof input.createdAt === "string" && input.createdAt ? input.createdAt : new Date().toISOString(),
    sizeBytes: typeof input.sizeBytes === "number" && Number.isFinite(input.sizeBytes) ? input.sizeBytes : 0,
  };
}

function objectKey(tenantId: TenantId, fileId: string): string {
  return tenantId === compatibilityTenantId ? `transit/${fileId}` : `transit/${tenantId}/${fileId}`;
}

function metadataKey(tenantId: TenantId, fileId: string): string {
  return tenantId === compatibilityTenantId ? `transit/${fileId}.meta.json` : `transit/${tenantId}/${fileId}.meta.json`;
}

function assertSafeFileId(fileId: string): void {
  if (!/^[a-f0-9]{32}(?:\.[a-z0-9]{1,16})?$/.test(fileId)) {
    throw new TransitFileError(404, "file_not_found", "Transit file was not found.");
  }
}

function safeExtension(name: string): string {
  const extension = extname(name).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(extension) ? extension : "";
}

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
