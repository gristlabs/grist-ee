import {Upload} from "@aws-sdk/lib-storage";
import {ApiError} from 'app/common/ApiError';
import {ObjMetadata, ObjSnapshotWithMetadata, toExternalMetadata, toGristMetadata} from 'app/common/DocSnapshot';
import {ExternalStorage} from 'app/server/lib/ExternalStorage';
import { DeleteObjectsRequest, GetObjectCommand, ObjectVersion, S3 } from '@aws-sdk/client-s3';
import * as fse from 'fs-extra';
import * as stream from 'node:stream';

/**
 * An external store implemented using S3.
 */
export class S3ExternalStorage implements ExternalStorage {
  // Create an S3 client. Using an explicit API version seems recommended.
  private _s3 = new S3({});

  // Specify bucket to use, and optionally the max number of keys to request
  // in any call to listObjectVersions (used for testing)
  constructor(public bucket: string, private _batchSize?: number) {}

  public async exists(key: string, snapshotId?: string) {
    return Boolean(await this.head(key, snapshotId));
  }

  public async head(key: string, snapshotId?: string): Promise<ObjSnapshotWithMetadata|null> {
    try {
      const head = await this._s3.headObject({
        Bucket: this.bucket, Key: key,
        ...(snapshotId && {VersionId: snapshotId}),
      });
      if (!head.LastModified || !head.VersionId) {
        // AWS documentation says these fields will be present.
        throw new Error('S3ExternalStorage.head did not get expected fields');
      }
      return {
        lastModified: head.LastModified.toISOString(),
        snapshotId: head.VersionId,
        ...(head.Metadata && { metadata: toGristMetadata(head.Metadata) }),
      };
    } catch (err) {
      if (!this.isFatalError(err)) { return null; }
      throw err;
    }
  }

  public async upload(key: string, fname: string, metadata?: ObjMetadata) {
    const stat = await fse.lstat(fname);
    const readStream = fse.createReadStream(fname);
    try {
      return await this.uploadStream(key, readStream, stat.size, metadata);
    } finally {
      readStream.destroy();
    }
  }

  public async uploadStream(key: string, inStream: stream.Readable, size?: number|undefined, metadata?: ObjMetadata) {
    const upload = new Upload({
      client: this._s3,
      params: {
        Bucket: this.bucket, Key: key, Body: inStream,
        ...(size && { ContentLength: size }),
        ...(metadata && {Metadata: toExternalMetadata(metadata)})
      }
    });
    const result = await upload.done();
    // Empirically VersionId is available in result for buckets with versioning enabled.
    // We rely on this only to detect stale versions() results.
    return (result as any).VersionId || null;
  }

  public async download(key: string, fname: string, snapshotId?: string) {
    const fileStream = fse.createWriteStream(fname);
    const download = await this.downloadStream(key, snapshotId);
    await stream.promises.pipeline(download.contentStream, fileStream);
    return download.metadata.snapshotId;
  }

  public async downloadStream(key: string, snapshotId?: string) {
    const response = await this._s3.send(new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ...(snapshotId && { VersionId: snapshotId }),
    }));

    const downloadedSnapshotId = response.VersionId ?? '';
    const fileSize = Number(response.ContentLength);
    if (Number.isNaN(fileSize)) {
      throw new ApiError('download error - bad file size', 500);
    }
    const contentStream = response.Body as stream.Readable;
    return {
      metadata: {
        snapshotId: downloadedSnapshotId,
        size: fileSize,
      },
      contentStream,
    };
  }

  public async remove(key: string, snapshotIds?: string[]) {
    if (snapshotIds) {
      await this._deleteBatch(key, snapshotIds);
    } else {
      await this._deleteAllVersions(key);
    }
  }

  public async removeAllWithPrefix(prefix: string) {
    await this._deleteAllVersions(prefix, { prefixMatch: true });
  }

  public async versions(key: string) {
    const versions: ObjectVersion[] = [];
    let KeyMarker: string|undefined;
    let VersionIdMarker: string|undefined;
    for (;;) {
      const status = await this._s3.listObjectVersions({
        Bucket: this.bucket, Prefix: key, KeyMarker, VersionIdMarker,
        ...(this._batchSize && {MaxKeys: this._batchSize})
      });
      if (status.Versions) { versions.push(...status.Versions); }
      if (!status.IsTruncated) { break; }   // we are done!
      KeyMarker = status.NextKeyMarker;
      VersionIdMarker = status.NextVersionIdMarker;
    }
    return versions
      .filter(v => v.Key === key && v.LastModified && v.VersionId)
      .map(v => ({
        lastModified: v.LastModified!.toISOString(),
        snapshotId: v.VersionId!,
      }));
  }

  public url(key: string) {
    return `s3://${this.bucket}/${key}`;
  }

  public isFatalError(err: any) {
    return err.name !== 'NotFound' && err.name !== 'NoSuchKey';
  }

  public async close() {
    // nothing to do
  }

  // Delete all versions of an object.
  public async _deleteAllVersions(key: string, options: {
    prefixMatch?: boolean,  // if set, delete anything matching key as a prefix
  } = {}) {
    let KeyMarker: string|undefined;
    let VersionIdMarker: string|undefined;
    const keyMatch = (v: ObjectVersion) => {
      return options.prefixMatch || v.Key == key;
    };
    for (;;) {
      const status = await this._s3.listObjectVersions({
        Bucket: this.bucket, Prefix: key, KeyMarker, VersionIdMarker,
        ...(this._batchSize && {MaxKeys: this._batchSize})
      });
      if (status.Versions) {
        await this._deleteBatch(key, status.Versions.filter(keyMatch).map(v => v.VersionId));
      }
      if (status.DeleteMarkers) {
        await this._deleteBatch(key, status.DeleteMarkers.filter(keyMatch).map(v => v.VersionId));
      }
      if (!status.IsTruncated) { break; }   // we are done!
      KeyMarker = status.NextKeyMarker;
      VersionIdMarker = status.NextVersionIdMarker;
    }
  }

  // Delete a batch of versions for an object.
  private async _deleteBatch(key: string, versions: Array<string | undefined>) {
    // Max number of keys per request is 1000, see:
    //   https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObjects.html
    const N = this._batchSize || 1000;
    for (let i = 0; i < versions.length; i += N) {
      const iVersions = versions.slice(i, i + N);
      const params: DeleteObjectsRequest = {
        Bucket: this.bucket,
        Delete: {
          Objects: iVersions.filter(v => v).map(v => ({
            Key: key,
            VersionId: v
          })),
          Quiet: true
        }
      };
      if (!params.Delete?.Objects?.length) { continue; }
      await this._s3.deleteObjects(params);
    }
  }
}
