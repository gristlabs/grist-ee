/**
 * BatchedJobs uses the Redis implementation of GristJobs to do batching.
 * Specifically, it's used for notifications, e.g. of document changes.
 *
 * The constructor accepts a map of schedules, e.g. like this:
 * {
 *   docChange: {
 *     type: 'email-docChange',
 *     firstDelay: 5 * 60_000,
 *     throttle: 30 * 60_000,
 *   },
 *   comment: {
 *     type: 'email-comments',
 *     firstDelay: 1 * 60_000,
 *     throttle: 5 * 60_000,
 *   }
 * }
 *
 * Run with NODE_DEBUG=batchedjobs,... for verbose logging.
 */

import {GristBullMQJobs, GristBullMQQueueScope, GristJob} from 'app/server/lib/GristJobs';
import * as log from 'app/server/lib/log';
import {popFromMap} from 'app/common/gutil';
import {Redis} from 'ioredis';
import {debuglog} from 'util';

const debug = debuglog('batchedjobs');

export interface Schedule {
  type: string;
  firstDelay: number;   // First batch is processed this long after first job.
  throttle: number;     // Subsequent batches are processed at this interval, until an empty batch.
}

function getJobId(schedule: Schedule, batchKey: string) {
  return `job:${schedule.type}:${batchKey}`;
}

function getPayloadKey(jobId: string) {
  return `payload:${jobId}`;
}

// This should be a number higher than anything possible in a batch, so that we can get a whole
// batch using Redis's LPOP in one call.
const batchUpperBound = 1_000_000_000;

export type Handler = (jobType: string, batchKey: string, batchedData: string[]) => Promise<void>;

export class BatchedJobs {
  private _redis: Redis;
  private _toReschedule = new Map<String, () => Promise<void>>();

  constructor(
    jobs: GristBullMQJobs,
    private _queue: GristBullMQQueueScope,
    private _name: string,
    private _types: {[jobType: string]: Schedule},
  ) {
    this._redis = jobs.getQueueOptions().connection!;
  }

  /**
   * This should only get called once, by a server that can handle such jobs.
   */
  public setHandler(handler: Handler) {
    this._queue.handleName(this._name, this._handleJob.bind(this, handler));
    const worker = this._queue.getWorker();
    if (!worker) { throw new Error('BatchedJobs.setHandler: queue.handleDefault must be called first'); }
    worker.on('completed', (job) => popFromMap(this._toReschedule, job.id!)?.());
  }

  /**
   * Add a job to the queue.
   */
  public async add(jobType: string, batchKey: string, data: string) {
    const schedule = this._types[jobType];
    if (!schedule) { throw new Error(`Unknown job type ${jobType}`); }
    const jobId = getJobId(schedule, batchKey);
    if (debug.enabled) { log.debug('adding job', jobId); }
    const newCount = await this._redis.rpush(getPayloadKey(jobId), data);
    if (newCount === 1) {
      // When newCount > 1, we know this jobId is already scheduled, so this call will be a no-op.
      await this._addJob({jobId, jobType, batchKey}, schedule.firstDelay);
    }
  }

  private async _handleJob(handler: Handler, job: GristJob): Promise<void> {
    const {jobId, jobType, batchKey} = job.data;
    if (debug.enabled) { log.debug('handling job', jobId); }
    const batchedData = await this._redis.lpop(getPayloadKey(jobId), batchUpperBound);
    if (batchedData?.length) {
      const schedule = this._types[jobType];
      await handler(jobType, batchKey, batchedData);

      // Reschedule this job using 'throttle' delay, which subsequent add()s will respect. We
      // can't do it here, so tell the 'completed' handler to finish this scheduling.
      //
      // Note a low-risk race condition: an add() between this handler finishing and the 'completed'
      // callback may add a job with 'firstDelay' (instead of the desired 'throttle' delay).
      this._toReschedule.set(jobId, () => this._addJob({jobId, jobType, batchKey}, schedule.throttle));
    }
  }

  private async _addJob(info: {jobId: string, jobType: string, batchKey: string}, delay: number) {
    await this._queue.add(this._name, info, {
      jobId: info.jobId,
      delay,
      removeOnComplete: true,
      removeOnFail: true,
    });
  }
}
