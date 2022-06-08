import * as azure from "@azure/storage-blob";
import {asyncFilter, asyncMap, toArray} from 'app/common/asyncIterators';
import {
  ObjMetadata,
  ObjSnapshot,
  ObjSnapshotWithMetadata,
  toExternalMetadata,
  toGristMetadata
} from 'app/common/DocSnapshot';
import {ExternalStorage} from 'app/server/lib/ExternalStorage';
import sortBy = require('lodash/sortBy');

/**
 * An external store implemented using Azure Blob Storage (similar to S3).
 * Very similar to S3ExternalStorage.
 */
export class AzureExternalStorage implements ExternalStorage {
  // Client scoped to a particular 'container' (similar to an S3 bucket)
  private readonly _client: azure.ContainerClient;

  constructor(public readonly container: string) {
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    if (!connectionString) {
      throw new Error("Set AZURE_STORAGE_CONNECTION_STRING");
    }
    this._client = azure.BlobServiceClient.fromConnectionString(connectionString).getContainerClient(container);
  }

  public async exists(key: string, snapshotId?: string): Promise<boolean> {
    return await this._version(key, snapshotId).exists();
  }

  public async head(key: string, snapshotId?: string): Promise<ObjSnapshotWithMetadata | null> {
    try {
      const head = await this._version(key, snapshotId).getProperties();
      if (!head.lastModified || !head.versionId) {
        throw new Error('AzureExternalStorage.head did not get expected fields');
      }
      return {
        lastModified: head.lastModified.toISOString(),
        snapshotId: head.versionId,
        ...head.metadata && {metadata: toGristMetadata(head.metadata)},
      };
    } catch (err) {
      if (!this.isFatalError(err)) { return null; }
      throw err;
    }
  }

  public async upload(key: string, fname: string, metadata?: ObjMetadata): Promise<string | null> {
    const result = await this._blob(key).uploadFile(
      fname,
      {metadata: metadata && toExternalMetadata(metadata)},
    );
    return result.versionId || null;
  }

  public async download(key: string, fname: string, snapshotId?: string): Promise<string> {
    const result = await this._version(key, snapshotId).downloadToFile(fname);
    return result.versionId!;
  }

  public async remove(key: string, snapshotIds?: string[]): Promise<void> {
    if (snapshotIds) {
      await this._deleteBatch(key, snapshotIds);
    } else {
      await this._deleteAllVersions(key);
    }
  }

  // List content versions that exist for the given key.  More recent versions should
  // come earlier in the result list.
  public async versions(key: string): Promise<ObjSnapshot[]> {
    const versionsIter = this._versionsIterator(key);
    const snapshotsIter = asyncMap(versionsIter, version => ({
      snapshotId: version.versionId!,
      lastModified: version.properties.lastModified.toISOString(),
    }));
    const arr: ObjSnapshot[] = await toArray(snapshotsIter);
    return sortBy(arr, o => o.lastModified).reverse();
  }

  public url(key: string): string {
    return this._blob(key).url;
  }

  public isFatalError(err: any): boolean {
    return err.statusCode !== 404;
  }

  public async close() {
    // nothing to do
  }

  // Delete all versions of an object.
  public async _deleteAllVersions(key: string) {
    // Sometimes the first request doesn't actually delete everything, repeat until they're all gone.
    for (;;) {
      const versions = this._versionsIterator(key);
      const versionsIds = await toArray(asyncMap(versions, version => version.versionId!));
      if (!versionsIds.length) {
        return;
      }
      // Need to specify deleting the actual blob and not just specific versions.
      // Putting this at the front seems to work best.
      versionsIds.unshift("");
      await this._deleteBatch(key, versionsIds);
    }
  }

  // Delete a batch of versions for an object.
  private async _deleteBatch(key: string, versions: string[]) {
    await this._client.getBlobBatchClient().deleteBlobs(
      versions.map(versionId => this._version(key, versionId))
    );
  }

  // Client scoped to a specific blob (similar to an S3 object)
  private _blob(key: string): azure.BlockBlobClient {
    // There are a few blob clients possible, and the choice of client at creation determines the type of blob.
    // Append blobs might also work, but the append-only restriction could maybe cause problems.
    return this._client.getBlockBlobClient(key);
  }

  // Client scoped to a specific blob version.
  // 'snapshotId' refers to the Grist concept of snapshots.
  // Azure has 'snapshots' which are not to be confused with versions and which we don't use.
  private _version(key: string, snapshotId?: string): azure.BlobClient {
    // Empty string means the 'current version', i.e. the blob itself instead of a specific version.
    return this._blob(key).withVersion(snapshotId || "");
  }

  private _versionsIterator(key: string): AsyncIterableIterator<azure.BlobItem> {
    const blobs = this._client.listBlobsFlat({includeVersions: true, prefix: key});
    return asyncFilter(blobs, version => version.name === key);
  }
}
