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
import log from 'app/server/lib/log';
import {Job as BullMQJob} from 'bullmq';
import {Redis} from 'ioredis';

export interface Schedule {
  type: string;         // Used in redis key, should be unique across Schedule and BatchedJobs instances.
  firstDelay: number;   // First batch is processed this long after first job.
  throttle: number;     // Subsequent batches are processed at this interval, until an empty batch.
}

function getJobId(schedule: Schedule, batchKey: string) {
  return `job:${schedule.type}:${batchKey}`;
}

function getPayloadKey(jobId: string) {
  return `payload:${jobId}`;
}

interface JobInfo {
  jobId: string;
  jobType: string;
  batchKey: string;
  logMeta: log.ILogMeta;
}

// This should be a number higher than anything possible in a batch, so that we can get a whole
// batch using Redis's LPOP in one call.
const batchUpperBound = 1_000_000_000;

export type Handler = (jobType: string, batchKey: string, batchedData: string[]) => Promise<void>;

export class BatchedJobs {
  private _redis: Redis;

  constructor(
    jobs: GristBullMQJobs,
    public readonly queue: GristBullMQQueueScope,
    private _name: string,
    private _types: {[jobType: string]: Schedule},
  ) {
    this._redis = jobs.getQueueOptions().connection!;
  }

  /**
   * This should only get called once, by a server that can handle such jobs.
   */
  public setHandler(handler: Handler) {
    this.queue.handleName(this._name, this._handleJob.bind(this, handler));
    const worker = this.queue.getWorker();
    if (!worker) { throw new Error('BatchedJobs.setHandler: queue.handleDefault must be called first'); }

    worker.on('completed', (job) => this._maybeReschedule(job));
    // We don't reschedule on failure: we'll add a job on next add() call, with 'firstDelay' for delay.
    worker.on('failed', (job, err) => { log.error(`BatchedJobs job ${job?.id} failed`, err); });
    worker.on('error', (err) => { log.error("BatchdJobs error", String(err)); });
  }

  /**
   * Add a job to the queue.
   */
  public async add(jobType: string, batchKey: string, logMeta: log.ILogMeta, data: string) {
    const schedule = this._types[jobType];
    if (!schedule) { throw new Error(`Unknown job type ${jobType}`); }
    const jobId = getJobId(schedule, batchKey);
    log.rawDebug(`BatchedJobs adding job`, {jobType, jobId, ...logMeta});

    // We are just doing rpush(key, data) here, plus batching with a check for whether a job
    // already exists. This is a minor optimization that allows us to make a single Redis
    // roundtrip in most cases, and only make a second trip for adding the job when needed.
    const key = getPayloadKey(jobId);

    let exists: number | undefined;
    await this._redis.pipeline()
      .rpush(key, data)
      .exists(this.queue.getJobRedisKey(jobId), (err, _exists) => { exists = _exists; })
      .exec();
    if (!exists) {
      await this._addJob({jobId, jobType, batchKey, logMeta}, schedule.firstDelay);
    }
  }

  private async _handleJob(handler: Handler, job: BullMQJob): Promise<void> {
    const {jobId, jobType, batchKey, logMeta} = job.data;
    log.rawDebug(`BatchedJobs handling job`, {jobType, jobId, ...logMeta});
    const batchedData = await this._redis.lpop(getPayloadKey(jobId), batchUpperBound);
    if (batchedData?.length) {
      const schedule = this._types[jobType];

      // We want this job rescheduled using 'throttle' delay, which subsequent add()s will
      // respect (they won't override a job with an existing ID). We can't reschedule a job while
      // it's running, but will do it on 'completed' and 'failed' handlers. We mark it for such
      // rescheduling by adding a 'rescheduleDelay' field with the delay to use.
      //
      // Note a low-risk race condition: an add() between this handler finishing and the 'completed'
      // callback may add a job with 'firstDelay' (instead of the desired 'throttle' delay).
      await job.updateData({jobId, jobType, batchKey, logMeta, rescheduleDelay: schedule.throttle});

      await handler(jobType, batchKey, batchedData);
    }
  }

  private async _addJob(info: JobInfo, delay: number) {
    await this.queue.add(this._name, info, {
      jobId: info.jobId,
      delay,
      removeOnComplete: true,
      removeOnFail: true,
    });
  }

  /**
   * After any job, if we delivered any notifications, we mark it for rescheduling. This is the
   * mechanism by which notifications after the first one are throttled by a longer delay (namely,
   * schedule.throttle).
   */
  private async _maybeReschedule(job: GristJob) {
    const {jobId, jobType, batchKey, logMeta, rescheduleDelay} = job.data;
    if (rescheduleDelay) {
      await this._addJob({jobId, jobType, batchKey, logMeta}, rescheduleDelay);
    }
  }
}
